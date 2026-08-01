import { useEffect, useMemo, useState } from "react";
import {
  getToolGatewaySettings,
  listToolConnections,
  listToolDefinitions,
  type ToolConnection,
  type ToolDefinition
} from "@lush/api-client";
import { Settings2Icon, WrenchIcon } from "lucide-react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from "../ui/dropdown-menu";

type ToolGroup = {
  connection: ToolConnection;
  definitions: ToolDefinition[];
};

export function SessionToolsMenu(props: {
  apiBaseUrl: string;
  disabledToolDefinitionIds: string[];
  disabled?: boolean;
  onChange: (disabledToolDefinitionIds: string[]) => void;
  onManageTools: () => void;
  runApiRequest: <T>(
    operation: (sessionToken: string) => Promise<T>
  ) => Promise<T>;
}) {
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [gatewayEnabled, setGatewayEnabled] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");

    void props.runApiRequest((token) =>
      getToolGatewaySettings(props.apiBaseUrl, token)
    ).then(async (settings) => {
      if (!active) return [];
      setGatewayEnabled(settings.enabled);
      if (!settings.enabled) return [];

      const response = await props.runApiRequest((token) =>
        listToolConnections(props.apiBaseUrl, token)
      );
      const connections = response.connections.filter(
        (connection) => connection.enabled
      );
      const definitions = await Promise.all(
        connections.map(async (connection) => {
          const result = await props.runApiRequest((token) =>
            listToolDefinitions(props.apiBaseUrl, connection.id, token)
          );
          return {
            connection,
            definitions: result.definitions.filter(
              (definition) =>
                definition.enabled && definition.policy.decision !== "deny"
            )
          };
        })
      );
      return definitions.filter((group) => group.definitions.length > 0);
    }).then((nextGroups) => {
      if (active) setGroups(nextGroups);
    }).catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Unable to load tools");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [props.apiBaseUrl]);

  const availableTools = useMemo(
    () => groups.flatMap((group) => group.definitions),
    [groups]
  );
  const disabledIds = new Set(props.disabledToolDefinitionIds);
  const enabledCount = availableTools.filter(
    (definition) => !disabledIds.has(definition.id)
  ).length;

  const setToolEnabled = (definitionId: string, enabled: boolean) => {
    const next = new Set(props.disabledToolDefinitionIds);
    if (enabled) next.delete(definitionId);
    else next.add(definitionId);
    props.onChange([...next].sort());
  };

  const setAllEnabled = (enabled: boolean) => {
    const availableIds = new Set(availableTools.map((tool) => tool.id));
    const next = new Set(
      props.disabledToolDefinitionIds.filter((id) => !availableIds.has(id))
    );
    if (!enabled) {
      for (const id of availableIds) next.add(id);
    }
    props.onChange([...next].sort());
  };

  const status = loading
    ? "Loading"
    : availableTools.length > 0
      ? `${enabledCount}/${availableTools.length}`
      : undefined;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={props.disabled} className="min-w-48 py-2">
        <WrenchIcon />
        <span>Tools</span>
        {status ? (
          <span className="ml-auto mr-1 text-xs text-muted-foreground">
            {status}
          </span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-96 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto p-1.5">
        <DropdownMenuLabel className="px-2 py-1.5">
          <span className="block text-sm font-medium text-foreground">
            Session tools
          </span>
          <span className="mt-0.5 block font-normal">Enabled for this session.</span>
        </DropdownMenuLabel>

        {loading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Loading tools…</p>
        ) : error ? (
          <p className="px-2 py-3 text-sm text-destructive">{error}</p>
        ) : !gatewayEnabled ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            The tool gateway is disabled for this organization.
          </p>
        ) : availableTools.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            No tools are currently available.
          </p>
        ) : (
          <>
            <DropdownMenuCheckboxItem
              indicator="switch"
              checked={enabledCount === availableTools.length}
              onCheckedChange={(checked) => setAllEnabled(checked === true)}
              onSelect={(event) => event.preventDefault()}
              className="px-2 py-2 font-medium"
            >
              Enable all
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {groups.map((group, index) => (
              <div key={group.connection.id}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="px-2 pt-1.5">
                  {group.connection.label}
                </DropdownMenuLabel>
                {group.definitions.map((definition) => (
                  <DropdownMenuCheckboxItem
                    key={definition.id}
                    indicator="switch"
                    checked={!disabledIds.has(definition.id)}
                    onCheckedChange={(checked) =>
                      setToolEnabled(definition.id, checked === true)
                    }
                    onSelect={(event) => event.preventDefault()}
                    className="px-2 py-2.5"
                    title={definition.description || undefined}
                  >
                    <span className="block min-w-0 truncate">
                      {definition.title || definition.externalName}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={props.onManageTools} className="px-2 py-2">
          <Settings2Icon />
          Manage tools
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
