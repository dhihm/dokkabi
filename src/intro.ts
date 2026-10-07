export function introMessage(): string {
  return "안녕하세요, 저는 Dokkabi입니다.";
}

if (import.meta.main) {
  process.stdout.write(`${introMessage()}\n`);
}
