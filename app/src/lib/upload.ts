// Shared upload plumbing for Sources/Brand (left rail + assets modal).

/** Resolve dropped items (files AND folders) into {relPath, file} pairs. */
export async function resolveDrop(items: DataTransferItemList): Promise<{ relPath: string; file: File }[]> {
  const out: { relPath: string; file: File }[] = [];
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => entry.file(res, rej));
      out.push({ relPath: prefix ? `${prefix}/${file.name}` : file.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns batches of ≤100 — drain until empty
      for (;;) {
        const batch = await new Promise<any[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };
  const entries = [...items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const files = [...items].map((i) => i.getAsFile());
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]) await walk(entries[i], "");
    else if (files[i]) out.push({ relPath: files[i]!.name, file: files[i]! });
  }
  return out;
}

export function readBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(String(reader.result).split(",")[1] ?? "");
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}
