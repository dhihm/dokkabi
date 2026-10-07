export function helloMessage(): string {
  return "Hello, world!";
}

if (import.meta.main) {
  process.stdout.write(`${helloMessage()}\n`);
}
