const publicKey = process.env.QONE_UPDATER_PUBKEY?.trim() ?? "";
const endpoint = process.env.QONE_UPDATER_ENDPOINT?.trim() ?? "";

if (publicKey !== "" && endpoint === "") {
  throw new Error("QONE_UPDATER_ENDPOINT is required when QONE_UPDATER_PUBKEY is set.");
}

if (endpoint !== "" && !endpoint.startsWith("https://")) {
  throw new Error("QONE_UPDATER_ENDPOINT must use an HTTPS URL.");
}

const updaterConfig = {
  plugins: {
    updater: {
      pubkey: publicKey,
      endpoints: endpoint === "" ? [] : [endpoint],
    },
  },
};

const child = Bun.spawn(
  [
    "bun",
    "run",
    "tauri",
    "build",
    "--config",
    JSON.stringify(updaterConfig),
    ...Bun.argv.slice(2),
  ],
  {
    cwd: import.meta.dir + "/..",
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await child.exited);
