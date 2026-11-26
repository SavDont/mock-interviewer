// Reads the text out of a resume PDF, locally in the browser (pdf.js), so it can be edited
// before the recruiter sees it.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface TextItem {
  str: string;
  hasEOL?: boolean;
  transform: number[];
}

export async function pdfToText(file: File): Promise<string> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const items = (await page.getTextContent()).items as TextItem[];
    let text = "";
    let lastY: number | null = null;
    for (const it of items) {
      const y = it.transform[5]!;
      // A jump in vertical position is a new line, even when the PDF doesn't mark one.
      if (lastY !== null && Math.abs(y - lastY) > 2 && !text.endsWith("\n")) text += "\n";
      text += it.str;
      if (it.hasEOL) text += "\n";
      lastY = y;
    }
    pages.push(text);
  }
  await task.destroy();
  return pages
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
