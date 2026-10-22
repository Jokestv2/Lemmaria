/**
 * The logic-less template renderer (schema spec §5, decision §12.1): variable
 * interpolation over dotted paths, `upper`/`trim` helpers, and nestable
 * `#if`/`#unless` blocks. No loops, no arbitrary expressions. Undeclared
 * variables render empty and warn. Hand-rolled per ADR 0005.
 */

export interface RenderResult {
  text: string;
  warnings: string[];
}

type BlockNode = {
  kind: "block";
  negate: boolean;
  path: string;
  children: Node[];
};
type Node =
  | { kind: "text"; value: string }
  | { kind: "var"; path: string; helper?: "upper" | "trim" }
  | BlockNode;

const TAG_RE = /\{\{([^{}]*)\}\}/g;
const PATH_RE = /^[A-Za-z_][\w.]*$/;

export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): RenderResult {
  const warnings: string[] = [];
  const nodes = parse(template, warnings);
  const text = renderNodes(nodes, vars, warnings);
  return { text, warnings };
}

function parse(template: string, warnings: string[]): Node[] {
  const root: Node[] = [];
  const stack: BlockNode[] = [];
  let children = root;
  let last = 0;
  for (const m of template.matchAll(TAG_RE)) {
    const index = m.index ?? 0;
    if (index > last) {
      children.push({ kind: "text", value: template.slice(last, index) });
    }
    last = index + m[0].length;
    const body = (m[1] ?? "").trim();
    if (body.startsWith("#if ") || body.startsWith("#unless ")) {
      const negate = body.startsWith("#unless ");
      const path = body.slice(body.indexOf(" ") + 1).trim();
      if (!PATH_RE.test(path)) {
        warnings.push(`unsupported template expression: {{${body}}}`);
        continue;
      }
      const block: BlockNode = { kind: "block", negate, path, children: [] };
      children.push(block);
      stack.push(block);
      children = block.children;
    } else if (body === "/if" || body === "/unless") {
      if (stack.length === 0) {
        warnings.push(`unmatched {{${body}}}`);
        continue;
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      children = parent ? parent.children : root;
    } else {
      const parts = body.split(/\s+/).filter((p) => p.length > 0);
      const helper = parts[0];
      if (
        parts.length === 2 &&
        (helper === "upper" || helper === "trim") &&
        PATH_RE.test(parts[1] ?? "")
      ) {
        children.push({ kind: "var", path: parts[1] as string, helper });
      } else if (parts.length === 1 && PATH_RE.test(parts[0] ?? "")) {
        children.push({ kind: "var", path: parts[0] as string });
      } else {
        warnings.push(`unsupported template expression: {{${body}}}`);
      }
    }
  }
  if (last < template.length) {
    children.push({ kind: "text", value: template.slice(last) });
  }
  for (const open of stack) {
    warnings.push(
      `unclosed {{#${open.negate ? "unless" : "if"} ${open.path}}}`,
    );
  }
  return root;
}

function lookup(
  vars: Record<string, unknown>,
  path: string,
  warnings: string[],
): unknown {
  let current: unknown = vars;
  for (const key of path.split(".")) {
    if (
      current !== null &&
      typeof current === "object" &&
      Object.hasOwn(current as Record<string, unknown>, key)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else {
      warnings.push(`undeclared template variable: ${path}`);
      return undefined;
    }
  }
  return current;
}

function truthy(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    value === "" ||
    value === 0 ||
    value === false
  );
}

function renderNodes(
  nodes: Node[],
  vars: Record<string, unknown>,
  warnings: string[],
): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.value;
    } else if (node.kind === "var") {
      const value = lookup(vars, node.path, warnings);
      let text = value === undefined || value === null ? "" : String(value);
      if (node.helper === "upper") text = text.toUpperCase();
      if (node.helper === "trim") text = text.trim();
      out += text;
    } else if (truthy(lookup(vars, node.path, warnings)) !== node.negate) {
      out += renderNodes(node.children, vars, warnings);
    }
  }
  return out;
}
