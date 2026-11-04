import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Lines with `any` written as a type (annotations, casts, type arguments); not the word in comments or strings. */
function anyLines(name: string, text: string): number[] {
  const src = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) lines.push(src.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return lines;
}

test('no `any` outside the tests (use unknown and narrow, see src/util/json.ts)', () => {
  const files = ['src', 'scripts', 'tools'].flatMap((date) => tsFiles(join(ROOT, date)));
  assert.ok(files.length > 50, 'found the sources');
  const found = files.flatMap((textValue) =>
    anyLines(textValue, readFileSync(textValue, 'utf8')).map((value) => `${relative(ROOT, textValue)}:${value}`),
  );
  assert.deepEqual(found, []);
});

test('the any check sees annotations, casts and type arguments, not comments', () => {
  assert.deepEqual(anyLines('x.ts', 'let a: any;\nconst b = 1 as any;\nf<any>(); // any\n/* any */'), [1, 2, 3]);
});
