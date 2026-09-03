import { File, Paths } from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

export type ReportExportFormat = "pdf" | "csv" | "json";

function exportName(name: string, extension: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = name.toLocaleLowerCase("id-ID").replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return `${safe || "niagacore"}-${stamp}.${extension}`;
}

async function shareCachedFile(file: File, mimeType: string, dialogTitle: string) {
  if (!file.exists || file.size <= 0) throw new Error("export_file_not_ready");
  if (!(await Sharing.isAvailableAsync())) throw new Error("sharing_not_available");
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle });
}

export async function sharePdfFromHtml(_name: string, html: string, dialogTitle: string) {
  const printed = await Print.printToFileAsync({ html });
  if (!printed.uri) throw new Error("export_file_not_ready");
  if (!(await Sharing.isAvailableAsync())) throw new Error("sharing_not_available");
  // expo-print already creates a readable PDF in the application cache. Share
  // that URI directly so Android does not need permission for a second copy.
  await Sharing.shareAsync(printed.uri, {
    mimeType: "application/pdf",
    dialogTitle,
    UTI: ".pdf",
  });
}

export async function shareTextReport(
  name: string,
  format: Exclude<ReportExportFormat, "pdf">,
  content: string,
  dialogTitle: string,
) {
  const mimeType = format === "csv" ? "text/csv" : "application/json";
  const destination = new File(Paths.cache, exportName(name, format));
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(content);
  await shareCachedFile(destination, mimeType, dialogTitle);
}
