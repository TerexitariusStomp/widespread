export type RefKind = "branch" | "tag" | "other";

export type RefLike = {
  name: string;
};

function shortRefName(refName: string): string {
  return refName.replace(/^refs\/(heads|tags)\//, "");
}

export function classifyRef(refName: string): RefKind {
  if (refName.startsWith("refs/heads/")) return "branch";
  if (refName.startsWith("refs/tags/")) return "tag";
  return "other";
}

export function formatRefOption(ref: RefLike): { name: string; displayName: string } {
  const short = shortRefName(ref.name);
  return {
    name: encodeURIComponent(short),
    displayName: short.length > 30 ? `${short.slice(0, 27)}...` : short,
  };
}

