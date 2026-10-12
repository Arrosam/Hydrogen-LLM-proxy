const JSON_MIME = "application/json";

/** Save `text` to the user's disk as `filename`, without a server round-trip. */
export function downloadFile(filename: string, text: string, type: string = JSON_MIME): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
