import { agentRoutes, agentTypes } from "@lush/agent/spec";
import { authzRoutes, authzTypes } from "@lush/authz/spec";
import { inferenceRoutes, inferenceTypes } from "@lush/inference/spec";
import { sessionRoutes, sessionTypes } from "@lush/sessions/spec";
import { toolsRoutes, toolsTypes } from "@lush/tools/spec";

export const apiGroup = "/v1beta";
export const apiHealthPath = `${apiGroup}/health` as const;

type ServiceRoute =
  | (typeof authzRoutes)[number]
  | (typeof inferenceRoutes)[number]
  | (typeof sessionRoutes)[number]
  | (typeof agentRoutes)[number]
  | (typeof toolsRoutes)[number];

type ApiRouteWithGroup<Route extends ServiceRoute = ServiceRoute> =
  Route extends ServiceRoute
    ? Omit<Route, "path"> & {
        path: `${typeof apiGroup}${Route["path"]}`;
      }
    : never;

const serviceRoutes: ServiceRoute[] = [
  ...authzRoutes,
  ...inferenceRoutes,
  ...sessionRoutes,
  ...agentRoutes,
  ...toolsRoutes
] as ServiceRoute[];

const apiRoutes = serviceRoutes.map(withApiGroup) as ApiRouteWithGroup[];

export const apiSpec = {
  apiGroup,
  healthPath: apiHealthPath,
  types: `
${authzTypes}

${inferenceTypes}

${sessionTypes}

${agentTypes}

${toolsTypes}
`,
  routes: apiRoutes
} as const;

export type ApiRoute = (typeof apiSpec.routes)[number];

function withApiGroup<const Route extends ServiceRoute>(
  route: Route
): ApiRouteWithGroup<Route> {
  return {
    ...route,
    path: `${apiGroup}${route.path}` as `${typeof apiGroup}${Route["path"]}`
  } as unknown as ApiRouteWithGroup<Route>;
}
