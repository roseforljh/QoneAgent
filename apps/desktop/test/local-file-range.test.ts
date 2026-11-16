import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localRangeResponse } from "../electron/local-file-range";

test("local media answers byte ranges with 206 slices so long videos can seek", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "qone-range-"));
  const file = path.join(directory, "clip.mp4");
  writeFileSync(file, "0123456789");
  try {
    const open = await localRangeResponse(file, "bytes=0-");
    expect(open.status).toBe(206);
    expect(open.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await open.text()).toBe("0123456789");
    const middle = await localRangeResponse(file, "bytes=2-5");
    expect(middle.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await middle.text()).toBe("2345");
    expect(await (await localRangeResponse(file, "bytes=-3")).text()).toBe("789");
    expect(await (await localRangeResponse(file, "bytes=8-99")).text()).toBe("89");
    expect((await localRangeResponse(file, "bytes=10-")).status).toBe(416);
    expect((await localRangeResponse(file, "bytes=0-", "HEAD")).headers.get("Content-Length")).toBe("10");
    expect((await localRangeResponse(path.join(directory, "gone.mp4"), "bytes=0-")).status).toBe(404);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
