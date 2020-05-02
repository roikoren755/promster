import type { TPromsterOptions, TMetricTypes } from '@promster/types';
import type { TRequestRecorder } from '@promster/metrics';
import type { Plugin, Request, ResponseToolkit } from 'hapi';

import semver from 'semver';
import merge from 'merge-options';
import pkg from '../../package.json';
import {
  Prometheus,
  createMetricTypes,
  createRequestRecorder,
  createGcObserver,
  defaultNormalizers,
  isRunningInKubernetes,
} from '@promster/metrics';

interface TPromsterRequest extends Request {
  plugins: {
    promster: {
      start: [number, number];
    };
  };
}

const extractPath = (request: Request) => request.route.path.replace(/\?/g, '');
const extractStatusCode = (request: Request) =>
  // @ts-ignore
  request.response ? request.response.statusCode : '';

let recordRequest: TRequestRecorder;
let upMetric: TMetricTypes['up'];
const getRequestRecorder = () => recordRequest;
const signalIsUp = () =>
  upMetric?.forEach((upMetricType) => upMetricType.set(1));
const signalIsNotUp = () =>
  upMetric?.forEach((upMetricType) => upMetricType.set(0));

const getAreServerEventsSupported = (actualVersion: string) =>
  Boolean(actualVersion && semver.satisfies(actualVersion, '>= 17.0.0'));
const getDoesResponseNeedInvocation = (actualVersion: string) =>
  Boolean(actualVersion && semver.satisfies(actualVersion, '< 17.0.0'));

const createPlugin = (
  {
    options: pluginOptions,
  }: {
    options?: TPromsterOptions;
  } = { options: undefined }
) => {
  const defaultedOptions = merge(
    createMetricTypes.defaultOptions,
    createRequestRecorder.defaultOptions,
    defaultNormalizers,
    pluginOptions
  );

  const shouldSkipMetricsByEnvironment =
    defaultedOptions.detectKubernetes === true && !isRunningInKubernetes();

  const metricTypes = createMetricTypes(defaultedOptions);
  const observeGc = createGcObserver(metricTypes);

  recordRequest = createRequestRecorder(metricTypes, defaultedOptions);
  upMetric = metricTypes?.up;

  if (!shouldSkipMetricsByEnvironment) {
    observeGc();
  }

  const plugin: Plugin<unknown> = {
    name: pkg.name,
    version: pkg.version,
    // @ts-ignore
    register(
      server,
      _registrationOptions,
      onRegistrationFinished = () => null
    ) {
      const areServerEventsSupported = getAreServerEventsSupported(
        server.version
      );
      const doesResponseNeedInvocation = getDoesResponseNeedInvocation(
        server.version
      );
      const onRequestHandler = (
        request: TPromsterRequest,
        h: ResponseToolkit
      ) => {
        request.plugins.promster = { start: process.hrtime() };
        // @ts-ignore
        return doesResponseNeedInvocation ? h.continue() : h.continue;
      };

      const onResponseHandler = (request: TPromsterRequest, response: any) => {
        const labels = Object.assign(
          {},
          {
            path: defaultedOptions.normalizePath(extractPath(request), {
              request,
              response,
            }),
            method: defaultedOptions.normalizeMethod(request.method, {
              request,
              response,
            }),
            status_code: defaultedOptions.normalizeStatusCode(
              extractStatusCode(request),
              { request, response }
            ),
          },
          defaultedOptions.getLabelValues &&
            defaultedOptions.getLabelValues(request, {})
        );

        const shouldSkipByRequest =
          defaultedOptions.skip &&
          defaultedOptions.skip(request, response, labels);

        if (!shouldSkipByRequest && !shouldSkipMetricsByEnvironment) {
          recordRequest(request.plugins.promster.start, {
            labels,
          });
        }

        if (doesResponseNeedInvocation) response.continue();
      };

      // NOTE: This version detection allows us to graceully support both new and old Hapi APIs.
      // This is very hard to type as we would have to import two aliased versions of types.
      if (areServerEventsSupported) {
        // @ts-ignore
        server.ext('onRequest', onRequestHandler);
        // @ts-ignore
        server.events.on('response', onResponseHandler);
      } else {
        // @ts-ignore
        server.ext('onRequest', onRequestHandler);
        // @ts-ignore
        server.ext('onPreResponse', onResponseHandler);
      }

      server.decorate('server', 'Prometheus', () => Prometheus);
      server.decorate('server', 'recordRequest', recordRequest);

      return onRegistrationFinished?.();
    },
  };
  // @ts-ignore
  plugin.register.attributes = {
    pkg,
  };

  return plugin;
};

export {
  createPlugin,
  getRequestRecorder,
  signalIsUp,
  signalIsNotUp,
  getAreServerEventsSupported,
  getDoesResponseNeedInvocation,
};