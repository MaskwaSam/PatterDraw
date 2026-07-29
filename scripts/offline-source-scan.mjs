import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const sourceExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

export const remoteSourceRules = [
  [/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//gi, "remote script source"],
  [/<link\b[^>]*\bhref\s*=\s*["']https?:\/\//gi, "remote stylesheet or preload"],
  [/<img\b[^>]*\bsrc\s*=\s*["']https?:\/\//gi, "remote image source"],
  [/\bfetch\s*\(\s*["'`]https?:\/\//g, "remote fetch"],
  [/\bimport\s*\(\s*["'`]https?:\/\//g, "remote dynamic import"],
  [/\bnew\s+(?:Worker|SharedWorker)\s*\(\s*["'`]https?:\/\//g, "remote worker"],
  [/\bserviceWorker\.register\s*\(\s*["'`]https?:\/\//g, "remote service worker"],
  [/\bnew\s+(?:WebSocket|EventSource)\s*\(/g, "live network channel"],
  [/\bsendBeacon\s*\(/g, "telemetry beacon"],
  [/\b(?:gtag|plausible|posthog|mixpanel|amplitude)\s*\(/gi, "analytics call"],
  [/<(?:iframe|object|embed)\b/gi, "embedded web-content markup"],
  [/\bwindow\.open\s*\(\s*["'`]https?:\/\//g, "external window navigation"],
  [/\blocation\.(?:assign|replace)\s*\(\s*["'`]https?:\/\//g, "external location navigation"],
  [/LiveCollaborationTrigger/g, "collaboration UI"],
  [/onCollabButtonClick/g, "collaboration callback"],
  [/useHandleLibrary/g, "URL-driven public library installation"],
  [/libraryReturnUrl\s*=/g, "remote library return URL"],
];

export const remoteCssRules = [
  [/@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//gi, "remote CSS import"],
  [/\burl\(\s*["']?\s*(?:https?:)?\/\//gi, "remote CSS asset"],
];

function addRuleFindings(
  source,
  relativeFile,
  rules,
  start,
  end,
  findings,
  seen,
) {
  const candidate = source.slice(start, end);
  for (const [pattern, label] of rules) {
    pattern.lastIndex = 0;
    for (const match of candidate.matchAll(pattern)) {
      const absoluteIndex = start + match.index;
      const findingKey = `${absoluteIndex}:${label}`;
      if (seen.has(findingKey)) continue;
      seen.add(findingKey);
      const line = source.slice(0, absoluteIndex).split("\n").length;
      findings.push(`${relativeFile}:${line} ${label}`);
    }
  }
}

function htmlCssRanges(source) {
  const ranges = [];
  const styleBlockPattern = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
  for (const match of source.matchAll(styleBlockPattern)) {
    const openingEnd = match[0].indexOf(">") + 1;
    const closingStart = match[0].toLowerCase().lastIndexOf("</style");
    if (openingEnd > 0 && closingStart >= openingEnd) {
      ranges.push([match.index + openingEnd, match.index + closingStart]);
    }
  }

  const openingTagPattern = /<[a-z][^<>]*>/gi;
  const styleAttributePattern = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/dgi;
  for (const tag of source.matchAll(openingTagPattern)) {
    styleAttributePattern.lastIndex = 0;
    for (const attribute of tag[0].matchAll(styleAttributePattern)) {
      const valueGroup = attribute[1] !== undefined ? 1 : attribute[2] !== undefined ? 2 : 3;
      const valueIndices = attribute.indices?.[valueGroup];
      if (valueIndices) {
        ranges.push([
          tag.index + valueIndices[0],
          tag.index + valueIndices[1],
        ]);
      }
    }
  }
  return ranges;
}

function scriptKindForExtension(extension) {
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isStyleJsxAttribute(node, sourceFile) {
  return ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "style";
}

function isStyleJsxElement(node, sourceFile) {
  return ts.isJsxElement(node)
    && node.openingElement.tagName.getText(sourceFile).toLowerCase() === "style";
}

function collectExpressionIdentifiers(node, identifiers) {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const isPropertyName = (
      (ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent))
      && parent.name === node
    );
    if (!isPropertyName) identifiers.add(node.text);
  }
  ts.forEachChild(node, (child) => collectExpressionIdentifiers(child, identifiers));
}

function isCssHelper(expression, sourceFile) {
  const text = expression.getText(sourceFile).replace(/\s+/g, "");
  return (
    /^(?:css|keyframes|createGlobalStyle|createStyles|makeStyles)$/.test(text)
    || /^styled(?:$|[.[(])/.test(text)
    || /\.(?:css|keyframes|createGlobalStyle|createStyles|makeStyles)$/.test(text)
  );
}

function scriptCssRanges(source, relativeFile, extension) {
  const sourceFile = ts.createSourceFile(
    relativeFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForExtension(extension),
  );
  const referencedStyleIdentifiers = new Set();
  const ranges = [];
  const rangeKeys = new Set();
  const isTestSource = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativeFile);

  const addNodeRange = (node) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const key = `${start}:${end}`;
    if (end <= start || rangeKeys.has(key)) return;
    rangeKeys.add(key);
    ranges.push([start, end]);
  };

  const collectStyleReferences = (node) => {
    if (isStyleJsxAttribute(node, sourceFile) && node.initializer) {
      if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        collectExpressionIdentifiers(node.initializer.expression, referencedStyleIdentifiers);
      }
    } else if (isStyleJsxElement(node, sourceFile)) {
      for (const child of node.children) {
        if (ts.isJsxExpression(child) && child.expression) {
          collectExpressionIdentifiers(child.expression, referencedStyleIdentifiers);
        }
      }
    } else if (
      ts.isPropertyAssignment(node)
      && node.name.getText(sourceFile).replace(/["']/g, "") === "style"
    ) {
      collectExpressionIdentifiers(node.initializer, referencedStyleIdentifiers);
    } else if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sourceFile);
      if (isCssHelper(node.expression, sourceFile)) {
        for (const argument of node.arguments) {
          collectExpressionIdentifiers(argument, referencedStyleIdentifiers);
        }
      } else if (
        /(?:^|\.)setAttribute$/.test(calleeText)
        && node.arguments[0]
        && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text.toLowerCase() === "style"
        && node.arguments[1]
      ) {
        collectExpressionIdentifiers(node.arguments[1], referencedStyleIdentifiers);
      } else if (
        calleeText === "Object.assign"
        && node.arguments[0]?.getText(sourceFile).endsWith(".style")
      ) {
        for (const argument of node.arguments.slice(1)) {
          collectExpressionIdentifiers(argument, referencedStyleIdentifiers);
        }
      }
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (
        /\.cssText$/.test(node.left.getText(sourceFile))
        || /\.style(?:\.|\[)/.test(node.left.getText(sourceFile))
      )
    ) {
      collectExpressionIdentifiers(node.right, referencedStyleIdentifiers);
    }
    ts.forEachChild(node, collectStyleReferences);
  };
  collectStyleReferences(sourceFile);

  const collectCssContexts = (node) => {
    if (isStyleJsxAttribute(node, sourceFile) && node.initializer) {
      addNodeRange(node.initializer);
    }
    if (isStyleJsxElement(node, sourceFile)) {
      for (const child of node.children) addNodeRange(child);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (
        referencedStyleIdentifiers.has(node.name.text)
        || node.type?.getText(sourceFile).includes("CSSProperties")
        || (!isTestSource && /(?:css|style)/i.test(node.name.text))
      )
    ) {
      addNodeRange(node.initializer);
    }
    if (
      ts.isPropertyAssignment(node)
      && node.name.getText(sourceFile).replace(/["']/g, "") === "style"
    ) {
      addNodeRange(node.initializer);
    }
    if (ts.isTaggedTemplateExpression(node) && isCssHelper(node.tag, sourceFile)) {
      addNodeRange(node.template);
    }
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sourceFile);
      if (isCssHelper(node.expression, sourceFile)) {
        for (const argument of node.arguments) addNodeRange(argument);
      } else if (
        /(?:^|\.)setAttribute$/.test(calleeText)
        && node.arguments[0]
        && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text.toLowerCase() === "style"
        && node.arguments[1]
      ) {
        addNodeRange(node.arguments[1]);
      } else if (
        calleeText === "Object.assign"
        && node.arguments[0]?.getText(sourceFile).endsWith(".style")
      ) {
        for (const argument of node.arguments.slice(1)) addNodeRange(argument);
      }
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (
        /\.cssText$/.test(node.left.getText(sourceFile))
        || /\.style(?:\.|\[)/.test(node.left.getText(sourceFile))
      )
    ) {
      addNodeRange(node.right);
    }
    ts.forEachChild(node, collectCssContexts);
  };
  collectCssContexts(sourceFile);

  return ranges.sort((left, right) => left[0] - right[0]);
}

export function isScannableSourceFile(fileName) {
  return sourceExtensions.has(path.extname(fileName));
}

export function findRemoteSourceReferences(source, relativeFile) {
  const findings = [];
  const seen = new Set();
  const extension = path.extname(relativeFile);
  addRuleFindings(
    source,
    relativeFile,
    remoteSourceRules,
    0,
    source.length,
    findings,
    seen,
  );
  const cssRanges = extension === ".css"
    ? [[0, source.length]]
    : extension === ".html"
      ? htmlCssRanges(source)
      : [".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extension)
        ? scriptCssRanges(source, relativeFile, extension)
        : [];
  for (const [start, end] of cssRanges) {
    addRuleFindings(
      source,
      relativeFile,
      remoteCssRules,
      start,
      end,
      findings,
      seen,
    );
  }
  return findings;
}

async function filesUnder(candidate) {
  const candidateStat = await stat(candidate);
  if (candidateStat.isFile()) return [candidate];
  const files = [];
  for (const entry of await readdir(candidate, { withFileTypes: true })) {
    const child = path.join(candidate, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (isScannableSourceFile(entry.name)) files.push(child);
  }
  return files;
}

export async function findRemoteSourceFindings(root, scanRoots) {
  const findings = [];
  for (const scanRoot of scanRoots) {
    for (const file of await filesUnder(scanRoot)) {
      const source = await readFile(file, "utf8");
      findings.push(...findRemoteSourceReferences(source, path.relative(root, file)));
    }
  }
  return findings;
}
