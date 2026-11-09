import { clientEntrypoints, type ClientEntrypoint } from "@/client/entrypoints";
import { getClientManifest } from "./manifest";

export type DocumentAssets = {
  styles: string[];
  moduleScripts: string[];
  preloads: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function collectManifestImports(
  manifest: Awaited<ReturnType<typeof getClientManifest>>,
  key: string | undefined,
  preloadSet: Set<string>
) {
  if (!key || preloadSet.has(key) || !manifest?.[key]) {
    return;
  }

  preloadSet.add(key);
  for (const importedKey of manifest[key].imports || []) {
    collectManifestImports(manifest, importedKey, preloadSet);
  }
}

export async function resolveDocumentAssets(
  env: Env,
  moduleEntries: ClientEntrypoint[]
): Promise<DocumentAssets> {
  if (import.meta.env.DEV) {
    return {
      styles: ["/src/client/styles.css"],
      moduleScripts: ["/@vite/client", ...moduleEntries.map((entry) => `/${entry}`)],
      preloads: [],
    };
  }

  const manifest = await getClientManifest(env);
  const styleEntry = manifest?.[clientEntrypoints.styles];
  const scriptEntries = moduleEntries
    .map((entry) => manifest?.[entry])
    .filter((entry): entry is NonNullable<typeof manifest>[string] => Boolean(entry));

  if (!styleEntry && scriptEntries.length === 0) {
    return {
      styles: [],
      moduleScripts: [],
      preloads: [],
    };
  }

  const preloadSet = new Set<string>();
  for (const entry of scriptEntries) {
    for (const importedKey of entry.imports || []) {
      collectManifestImports(manifest, importedKey, preloadSet);
    }
  }

  return {
    styles: unique(
      [...(styleEntry?.css || []), ...scriptEntries.flatMap((entry) => entry.css || [])].map(
        (href) => `/${href}`
      )
    ),
    moduleScripts: unique(scriptEntries.map((entry) => `/${entry.file}`)),
    preloads: unique(
      [...preloadSet]
        .map((key) => manifest?.[key]?.file)
        .filter((value): value is string => Boolean(value))
        .map((href) => `/${href}`)
    ),
  };
}
