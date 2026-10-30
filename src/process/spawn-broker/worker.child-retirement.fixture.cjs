const mode = process.argv[2];
const nonce = process.argv[3];
const out = "O".repeat(4096) + "<OUT:" + nonce + ">";
const err = "E".repeat(4096) + "<ERR:" + nonce + ">";
const write = (stream, text) => new Promise((resolve, reject) => stream.write(text, (error) => error ? reject(error) : resolve()));
(async () => {
  await Promise.all([write(process.stdout, out), write(process.stderr, err)]);
  if (mode === "ipc") {
    await new Promise((resolve, reject) => process.send({ nonce }, (error) => error ? reject(error) : resolve()));
    process.disconnect();
  }
})().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
