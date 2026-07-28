import { useState, type FormEvent } from "react";
import type {
  AddInferenceProviderRequest,
  InferenceConfig,
  InferenceProviderKind,
  ModelDefaults,
  UserRole,
  WorkspaceMode
} from "@lush/api-client";
import { workspaceModes } from "../../lib/app-data";
import { Dropdown } from "../../ui/Dropdown";

type InferenceProvider = InferenceConfig["providers"][number];

const providerQuickstarts: Array<{
  kind: InferenceProviderKind;
  label: string;
  baseUrl: string;
  description: string;
}> = [
  {
    kind: "baseten",
    label: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    description: "Use a Baseten OpenAI-compatible endpoint."
  },
  {
    kind: "fireworks",
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    description: "Discover Fireworks-hosted chat models."
  },
  {
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    description: "Discover Claude models with an Anthropic API key."
  },
  {
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    description: "Use OpenAI models through the Responses API."
  },
  {
    kind: "openai-compatible",
    label: "Other",
    baseUrl: "",
    description: "Connect any OpenAI-compatible API endpoint."
  }
];

export function InferenceSettingsPage(props: {
  currentRole?: UserRole;
  inferenceConfig?: InferenceConfig;
  modelDefaults: ModelDefaults;
  inferenceProviderError: string;
  isAddingInferenceProvider: boolean;
  refreshingInferenceProviderId: string;
  onAddInferenceProvider: (
    request: AddInferenceProviderRequest
  ) => Promise<unknown>;
  onProviderEnabledChange: (
    providerId: string,
    enabled: boolean
  ) => Promise<unknown>;
  onProviderModelsRefresh: (providerId: string) => Promise<unknown>;
  onProviderDelete: (providerId: string) => Promise<unknown>;
  onModelEnabledChange: (
    providerId: string,
    modelId: string,
    enabled: boolean
  ) => Promise<unknown>;
  onModelDefaultChange: (
    mode: WorkspaceMode,
    modelSelection: string
  ) => Promise<unknown>;
}) {
  const isAdmin = props.currentRole === "admin";
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [providerKind, setProviderKind] =
    useState<InferenceProviderKind>("fireworks");
  const [providerLabel, setProviderLabel] = useState("Fireworks");
  const [providerBaseUrl, setProviderBaseUrl] = useState(
    "https://api.fireworks.ai/inference/v1"
  );
  const [providerApiKey, setProviderApiKey] = useState("");
  const [openModelMenu, setOpenModelMenu] = useState("");
  const [providerPendingDeletion, setProviderPendingDeletion] =
    useState<InferenceProvider>();
  const selectedQuickstart =
    providerQuickstarts.find((quickstart) => quickstart.kind === providerKind)
  ;
  const hasProviders = (props.inferenceConfig?.providers.length ?? 0) > 0;

  const selectQuickstart = (kind: InferenceProviderKind) => {
    const quickstart = providerQuickstarts.find((item) => item.kind === kind);
    if (!quickstart) {
      return;
    }

    setProviderKind(quickstart.kind);
    setProviderLabel(quickstart.label);
    setProviderBaseUrl(quickstart.baseUrl);
  };

  const submitProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAdmin) {
      return;
    }

    await props.onAddInferenceProvider({
      kind: providerKind,
      label: providerLabel,
      apiKey: providerApiKey,
      baseUrl: providerBaseUrl
    });

    setProviderApiKey("");
    setProviderFormOpen(false);
  };

  const confirmProviderDelete = async () => {
    const provider = providerPendingDeletion;
    if (!provider) {
      return;
    }

    await props.onProviderDelete(provider.id);
    setProviderPendingDeletion(undefined);
  };

  return (
    <div className="grid max-w-3xl gap-4">
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-md">
              <h2 className="text-sm font-medium text-[var(--color-text)]">
                Inference
              </h2>
              <p className="mt-1 text-sm leading-5 text-[var(--color-muted)]">
                {isAdmin
                  ? "Connect providers and choose default models."
                  : "View connected providers and model defaults."}
              </p>
            </div>

            {isAdmin ? (
              <button
                type="button"
                onClick={() => setProviderFormOpen((open) => !open)}
                className="self-start rounded-md border border-[var(--color-brand)] bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white transition hover:border-[var(--color-brand-strong)] hover:bg-[var(--color-brand-strong)]"
              >
                Add provider
              </button>
            ) : null}
          </div>

          {providerFormOpen && isAdmin ? (
            <form
              onSubmit={submitProvider}
              className="grid gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3"
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {providerQuickstarts.map((quickstart) => (
                    <button
                      key={quickstart.kind}
                      type="button"
                      onClick={() => selectQuickstart(quickstart.kind)}
                      className={`rounded-md border p-3 text-left transition ${
                        providerKind === quickstart.kind
                          ? "border-[var(--color-brand)] bg-[var(--color-panel-hover)]"
                          : "border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]"
                      }`}
                    >
                      <span className="block text-sm font-medium text-[var(--color-text)]">
                        {quickstart.label}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-[var(--color-muted)]">
                        {quickstart.description}
                      </span>
                    </button>
                ))}
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                <label className="grid gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    Provider name
                  </span>
                  <input
                    type="text"
                    value={providerLabel}
                    onInput={(event) =>
                      setProviderLabel(event.currentTarget.value)
                    }
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-muted)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    API key
                  </span>
                  <input
                    type="password"
                    value={providerApiKey}
                    onInput={(event) =>
                      setProviderApiKey(event.currentTarget.value)
                    }
                    placeholder="Paste API key, stored securely"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-muted)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    Base URL
                  </span>
                  <input
                    type="url"
                    value={providerBaseUrl}
                    onInput={(event) =>
                      setProviderBaseUrl(event.currentTarget.value)
                    }
                    placeholder={
                      selectedQuickstart?.kind === "openai-compatible"
                        ? "https://api.example.com/v1"
                        : selectedQuickstart?.baseUrl
                    }
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-muted)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
                  />
                </label>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setProviderFormOpen(false)}
                  className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    props.isAddingInferenceProvider ||
                    !providerLabel.trim() ||
                    !providerApiKey.trim() ||
                    !providerBaseUrl.trim()
                  }
                  className="rounded-md border border-[var(--color-brand)] bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white transition hover:border-[var(--color-brand-strong)] hover:bg-[var(--color-brand-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {props.isAddingInferenceProvider
                    ? "Discovering models"
                    : "Connect provider"}
                </button>
              </div>
            </form>
          ) : null}

          {props.inferenceProviderError ? (
            <p
              role="alert"
              className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300"
            >
              {props.inferenceProviderError}
            </p>
          ) : null}

          <div className="grid gap-2">
            {props.inferenceConfig && hasProviders ? (
              props.inferenceConfig.providers.map((provider) => (
                      <div key={provider.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
                        <div
                          className={`flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between ${
                            provider.enabled
                              ? "border-b border-[var(--color-border)]"
                              : ""
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-sm font-medium text-[var(--color-text)]">
                                {provider.label}
                              </h3>
                              <span
                                className={`rounded-md px-2 py-1 text-xs font-medium ${
                                  provider.enabled
                                    ? "bg-[var(--color-brand)] text-white"
                                    : "bg-[var(--color-bg)] text-[var(--color-muted)]"
                                }`}
                              >
                                {provider.enabled ? "Enabled" : "Disabled"}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-xs text-[var(--color-muted)]">
                              {provider.baseUrl}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-md px-2 py-1 text-xs font-medium ${
                                provider.configured
                                  ? "bg-[var(--color-card)] text-[var(--color-subtle)]"
                                  : "bg-[var(--color-bg)] text-[var(--color-muted)]"
                              }`}
                            >
                              {provider.configured ? "Configured" : "Missing key"}
                            </span>
                            {isAdmin ? (
                              <>
                                <button
                                  type="button"
                                  disabled={Boolean(
                                    props.refreshingInferenceProviderId
                                  )}
                                  onClick={() =>
                                    void props.onProviderModelsRefresh(provider.id)
                                  }
                                  className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-muted)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {props.refreshingInferenceProviderId ===
                                  provider.id
                                    ? "Refreshing..."
                                    : "Refresh models"}
                                </button>
                                <ToggleSwitch
                                checked={provider.enabled}
                                label={`${provider.enabled ? "Disable" : "Enable"} ${provider.label}`}
                                onChange={() =>
                                  void props.onProviderEnabledChange(
                                    provider.id,
                                    !provider.enabled
                                  )
                                }
                              />
                                <button
                                type="button"
                                onClick={() => setProviderPendingDeletion(provider)}
                                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-muted)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                              >
                                Delete
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>

                        {provider.enabled ? (
                          <div className="grid divide-y divide-[var(--color-border)]">
                            {provider.models.map((model) => {
                                const modelSelection = `${provider.id}:${model.id}`;
                                const selectedModes = workspaceModes.filter(
                                    (mode) =>
                                      props.modelDefaults[mode.value] ===
                                      modelSelection
                                  );
                                const menuOpen = openModelMenu === modelSelection;

                                return (
                                  <div
                                    key={model.id}
                                    className={`grid gap-3 px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)] lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center ${
                                      model.enabled ? "" : "opacity-60"
                                    }`}
                                  >
                                    {isAdmin ? (
                                      <ToggleSwitch
                                        checked={model.enabled}
                                        label={`${model.enabled ? "Disable" : "Enable"} ${model.label}`}
                                        onChange={() =>
                                          void props.onModelEnabledChange(
                                            provider.id,
                                            model.id,
                                            !model.enabled
                                          )
                                        }
                                      />
                                    ) : (
                                        <span
                                          className={`rounded-md border px-2 py-1 text-xs font-medium ${
                                            model.enabled
                                              ? "border-[var(--color-brand)] text-[var(--color-brand-soft)]"
                                              : "border-[var(--color-border)] text-[var(--color-muted)]"
                                          }`}
                                        >
                                          {model.enabled ? "Enabled" : "Disabled"}
                                        </span>
                                    )}

                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-medium text-[var(--color-text)]">
                                          {model.label}
                                        </p>
                                        <span className="rounded-md bg-[var(--color-card)] px-2 py-1 text-xs font-medium text-[var(--color-muted)]">
                                          {model.enabled ? "Enabled" : "Disabled"}
                                        </span>
                                      </div>
                                      <p className="mt-1 truncate text-xs text-[var(--color-muted)]">
                                        {model.id}
                                      </p>
                                    </div>

                                    <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
                                      {selectedModes.map((mode) => (
                                          <span key={mode.value} className="rounded-md border border-[var(--color-brand)] bg-[var(--color-brand)] px-2 py-1 text-xs font-medium text-white">
                                            {mode.label}
                                          </span>
                                      ))}

                                      {isAdmin ? (
                                        <Dropdown
                                          open={menuOpen}
                                          onOpenChange={(open) =>
                                            setOpenModelMenu(
                                              open ? modelSelection : ""
                                            )
                                          }
                                          className="relative"
                                          contentClass="absolute right-0 top-8 z-20 min-w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-1 shadow-lg"
                                          trigger={(dropdown) => (
                                            <button
                                              type="button"
                                              aria-label={`Model actions for ${model.label}`}
                                              aria-expanded={dropdown.isOpen()}
                                              disabled={!model.enabled}
                                              onClick={dropdown.toggle}
                                              className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                              <span className="grid gap-0.5">
                                                <span className="h-1 w-1 rounded-full bg-current" />
                                                <span className="h-1 w-1 rounded-full bg-current" />
                                                <span className="h-1 w-1 rounded-full bg-current" />
                                              </span>
                                            </button>
                                          )}
                                        >
                                          <div className="px-2 py-1.5 text-xs font-medium text-[var(--color-muted)]">
                                            Set default as...
                                          </div>
                                          {workspaceModes.map((mode) => (
                                              <button
                                                key={mode.value}
                                                type="button"
                                                onClick={() => {
                                                  props.onModelDefaultChange(
                                                    mode.value,
                                                    modelSelection
                                                  );
                                                  setOpenModelMenu("");
                                                }}
                                                className="block w-full rounded px-2 py-1.5 text-left text-xs font-medium text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                                              >
                                                {mode.label}
                                              </button>
                                          ))}
                                        </Dropdown>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                            })}
                          </div>
                        ) : null}
                      </div>
              ))
            ) : !providerFormOpen ? (
              <EmptyProviders
                readOnly={!isAdmin}
                onAdd={() => setProviderFormOpen(true)}
              />
            ) : null}
          </div>
        </div>
      </section>

      {providerPendingDeletion ? (
          <ProviderDeleteModal
            providerLabel={providerPendingDeletion.label}
            onCancel={() => setProviderPendingDeletion(undefined)}
            onConfirm={() => void confirmProviderDelete()}
          />
      ) : null}
    </div>
  );
}

function ProviderDeleteModal(props: {
  providerLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-provider-title"
        className="grid w-full max-w-sm gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 shadow-2xl shadow-[var(--shadow-menu)]"
      >
        <div>
          <h2
            id="delete-provider-title"
            className="text-sm font-semibold text-[var(--color-text)]"
          >
            Delete provider?
          </h2>
          <p className="mt-2 text-sm leading-5 text-[var(--color-muted)]">
            This permanently removes {props.providerLabel} and its discovered
            models from this organization.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            className="rounded-md border border-red-700 bg-red-700 px-3 py-2 text-sm font-medium text-white transition hover:border-red-800 hover:bg-red-800"
          >
            Delete provider
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyProviders(props: { readOnly: boolean; onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-panel)] p-6 text-center">
      <p className="text-sm font-medium text-[var(--color-text)]">
        No inference providers connected
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--color-muted)]">
        {props.readOnly
          ? "Ask an organization admin to connect a provider before using organization models."
          : "Add Baseten, Fireworks, Anthropic, OpenAI, or any OpenAI-compatible endpoint. Lush will use the supplied credentials to discover available chat models."}
      </p>
      {!props.readOnly ? (
        <button
          type="button"
          onClick={props.onAdd}
          className="mt-4 rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
        >
          Add provider
        </button>
      ) : null}
    </div>
  );
}

function ToggleSwitch(props: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={props.onChange}
      className={`group relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border p-0.5 transition duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-panel)] ${
        props.checked
          ? "border-[var(--color-brand)] bg-[var(--color-brand)]"
          : "border-[var(--color-border-strong)] bg-[var(--color-card)] hover:bg-[var(--color-panel-hover)]"
      }`}
    >
      <span
        className={`h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
          props.checked ? "translate-x-[20px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
