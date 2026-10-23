import test from "node:test";
import assert from "node:assert/strict";
import { atsNormalize, atsCheck, canonicalHeading } from "../web/resume-ats.js";
import { textToDocx, crc32 } from "../web/docx-lite.js";

const MESSY = `Jordan Sample
jordan.sample@example.invalid   (555) 010-0199
• Led “weekly” reviews — cut load time 40%
Professional Experience
Senior Data Engineer\t\tExample Co\t\tMar 2021 – Present
● Built pipelines 🚀
Technical Skills
Python, SQL
`;

test("normalize: ASCII punctuation, plain bullets, standard headings, no columns or emoji", () => {
  const out = atsNormalize(MESSY);
  assert.match(out, /^- Led "weekly" reviews - cut load time 40%$/m);
  assert.match(out, /^WORK EXPERIENCE$/m);
  assert.match(out, /^SKILLS$/m);
  assert.match(out, /Senior Data Engineer \| Example Co \| Mar 2021 - Present/);
  assert.doesNotMatch(out, /[•●\t–—“\ud83d]/);
  assert.match(out, /Built pipelines/, "wording is untouched");
});

test("normalize keeps accented letters in names", () => {
  assert.match(atsNormalize("José Núñez\nEDUCATION"), /José Núñez/);
});

test("check flags what a parser would trip on, and passes after normalizing", () => {
  const before = atsCheck(MESSY);
  const by = Object.fromEntries(before.map((c) => [c.label, c]));
  assert.equal(by["Plain layout"].ok, false);
  assert.equal(by["Standard section headings"].ok, false);
  assert.equal(by["Contact details at the top"].ok, true);
  const needsEdu = atsCheck(atsNormalize(MESSY)).find((c) => c.label === "Standard section headings");
  assert.match(needsEdu.detail, /education/);
  const good = atsCheck(atsNormalize(MESSY + "\nEducation\nExample State University, 2017\n"));
  assert.ok(good.every((c) => c.ok), JSON.stringify(good.filter((c) => !c.ok)));
});

test("check: missing contact and dates are called out", () => {
  const r = atsCheck("Nobody\nSKILLS\nPython");
  assert.equal(r.find((c) => c.label === "Contact details at the top").ok, false);
  assert.equal(r.find((c) => c.label === "Dates on each role").ok, false);
});

test("headings map to one canonical name", () => {
  for (const h of ["Work History", "EMPLOYMENT", "Professional Experience:"]) assert.equal(canonicalHeading(h), "WORK EXPERIENCE");
  assert.equal(canonicalHeading("Hobbies"), null);
});

function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    const dataStart = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const data = bytes.slice(dataStart, dataStart + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files[name] = new TextDecoder().decode(data);
    p += 46 + nameLen;
  }
  return files;
}

test("docx: a valid zip of three parts with the text, headings bold, XML escaped", () => {
  const files = readZip(textToDocx("Jordan Sample\nWORK EXPERIENCE\n- Built <fast> & safe pipelines\n"));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const doc = files["word/document.xml"];
  assert.match(doc, /Built &lt;fast&gt; &amp; safe pipelines/);
  assert.match(doc, /<w:b\/><\/w:rPr><w:t xml:space="preserve">WORK EXPERIENCE/);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
