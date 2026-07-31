import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import {
  generateJwtKeyPair,
  quoteEnvJsonValue,
  quoteEnvValue
} from "../../services/authz/src/jwt-keys";

export const devEnvPath = ".env.development";
export const devEnvTemplatePath = ".env.template";

const keyIdPlaceholder = "__GENERATED_LUSH_AUTH_JWT_KEY_ID__";
const privateKeyPlaceholder = "__GENERATED_LUSH_AUTH_JWT_PRIVATE_KEY__";
const publicKeysPlaceholder = "__GENERATED_LUSH_AUTH_JWT_PUBLIC_KEYS__";
const secretKeyPlaceholder = "__GENERATED_LUSH_SECRET_KEY__";
const toolCredentialKeyPlaceholder = "__GENERATED_LUSH_TOOL_CREDENTIAL_KEY__";
const devEmailDefaults = {
  LUSH_EMAIL_DELIVERY: "log",
  LUSH_PUBLIC_APP_URL: "http://localhost:5874"
} as const;

export type DevEnvSecrets = {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  secretKey: string;
  toolCredentialKey: string;
};

export async function ensureDevEnvFile(options: {
  envPath?: string;
  templatePath?: string;
} = {}) {
  const envPath = options.envPath ?? devEnvPath;
  const templatePath = options.templatePath ?? devEnvTemplatePath;

  if (await fileExists(envPath)) {
    const contents = await Bun.file(envPath).text();
    const updatedContents = withDevDefaults(contents);
    if (updatedContents !== contents) {
      await Bun.write(envPath, updatedContents);
    }
    return {
      created: false as const,
      updated: updatedContents !== contents,
      path: envPath
    };
  }

  const template = await Bun.file(templatePath).text();
  const contents = withDevDefaults(
    fillDevEnvTemplate(template, await generateDevEnvSecrets())
  );
  await Bun.write(envPath, contents);

  return {
    created: true as const,
    updated: false,
    path: envPath
  };
}

function withDevDefaults(contents: string) {
  const defaults = {
    ...devEmailDefaults,
    LUSH_TOOL_CREDENTIAL_KEY: randomHex(32)
  };
  const additions = Object.entries(defaults)
    .filter(([name]) => !new RegExp(`^${name}=`, "m").test(contents))
    .map(([name, value]) => `${name}=${value}`);
  return additions.length > 0
    ? `${contents.trimEnd()}\n${additions.join("\n")}\n`
    : contents;
}

export function fillDevEnvTemplate(template: string, secrets: DevEnvSecrets) {
  const missingPlaceholders = [
    keyIdPlaceholder,
    privateKeyPlaceholder,
    publicKeysPlaceholder,
    secretKeyPlaceholder,
    toolCredentialKeyPlaceholder
  ].filter((placeholder) => !template.includes(placeholder));

  if (missingPlaceholders.length > 0) {
    throw new Error(
      `.env template is missing placeholders: ${missingPlaceholders.join(", ")}`
    );
  }

  return template
    .replace(keyIdPlaceholder, secrets.keyId)
    .replace(privateKeyPlaceholder, quoteEnvValue(secrets.privateKeyPem))
    .replace(
      publicKeysPlaceholder,
      quoteEnvJsonValue(
        JSON.stringify({ [secrets.keyId]: secrets.publicKeyPem })
      )
    )
    .replace(secretKeyPlaceholder, quoteEnvValue(secrets.secretKey))
    .replace(
      toolCredentialKeyPlaceholder,
      quoteEnvValue(secrets.toolCredentialKey)
    );
}

export async function generateDevEnvSecrets(): Promise<DevEnvSecrets> {
  const keyPair = await generateJwtKeyPair();

  return {
    ...keyPair,
    secretKey: randomHex(32),
    toolCredentialKey: randomHex(32)
  };
}

function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fileExists(path: string) {
  if (existsSync(path)) {
    return true;
  }

  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
