import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeToPdf } from "../web/resume-pdf.js";

test("resume export is a valid, escaped, paginated PDF string", () => {
  const pdf = resumeToPdf(`Sairaj (Demo)\nSenior Analyst — Python • SQL\n\n${"Built useful reports ".repeat(300)}`);
  assert.ok(pdf.startsWith("%PDF-1.4\n"));
  assert.ok(pdf.includes("Sairaj \\(Demo\\)"));
  assert.ok(pdf.includes("Senior Analyst - Python - SQL"));
  assert.match(pdf, /\/Count 2\b/);
  assert.ok(pdf.endsWith("%%EOF\n"));
  assert.ok(!/[^\x00-\x7F]/.test(pdf), "the generated PDF structure is ASCII encoded");
});
