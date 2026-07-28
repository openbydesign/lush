import type {
  InferenceModelCapabilities,
  InferenceModelFeature,
  InferenceModelInputModality,
  InferenceModelInterface,
  InferenceModelOutputModality
} from "@lush/db/schema";

export function mergeModelCapabilities(
  ...values: InferenceModelCapabilities[]
): InferenceModelCapabilities {
  return compactCapabilities({
    interfaces: unique(values.flatMap((value) => value.interfaces ?? [])),
    inputModalities: unique(
      values.flatMap((value) => value.inputModalities ?? [])
    ),
    outputModalities: unique(
      values.flatMap((value) => value.outputModalities ?? [])
    ),
    features: unique(values.flatMap((value) => value.features ?? []))
  });
}

export function compactCapabilities(value: {
  interfaces?: InferenceModelInterface[];
  inputModalities?: InferenceModelInputModality[];
  outputModalities?: InferenceModelOutputModality[];
  features?: InferenceModelFeature[];
}): InferenceModelCapabilities {
  return {
    ...(value.interfaces?.length ? { interfaces: unique(value.interfaces) } : {}),
    ...(value.inputModalities?.length
      ? { inputModalities: unique(value.inputModalities) }
      : {}),
    ...(value.outputModalities?.length
      ? { outputModalities: unique(value.outputModalities) }
      : {}),
    ...(value.features?.length ? { features: unique(value.features) } : {})
  };
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}
