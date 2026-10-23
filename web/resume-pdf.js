const toPdfText = (value) => String(value ?? "")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/[•·]/g, "-")
  .replace(/[^\x20-\x7E]/g, "");

function escapePdf(value) { return toPdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }

function wrap(text, width = 92) {
  const words = toPdfText(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const out = [];
  let line = "";
  for (const word of words) {
    if (word.length > width) {
      if (line) { out.push(line); line = ""; }
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
    } else if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

// A small text-only PDF writer for downloadable tailored resumes; no remote library or service is used.
export function resumeToPdf(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").flatMap((line) => line ? wrap(line) : [""]);
  const perPage = 48;
  const pages = [];
  for (let i = 0; i < lines.length || i === 0; i += perPage) pages.push(lines.slice(i, i + perPage));
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((pageLines, i) => {
    const pageId = pageIds[i], streamId = pageId + 1;
    const commands = ["BT", "/F1 10 Tf", "72 748 Td", "13 TL", ...pageLines.map((line) => `(${escapePdf(line)}) Tj T*`), "ET"].join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId] = `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`;
  });
  let pdf = "%PDF-1.4\n% Job Compass resume\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
