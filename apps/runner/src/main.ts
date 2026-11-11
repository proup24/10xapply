const USAGE = `usage: runner <command>
  session          sign in to LinkedIn through the bridge
  bot-check        run the bot-detection check
  bridge install   install the bridge extension
  bridge check     check the bridge extension`;

export async function main(argv: string[]): Promise<number> {
  void argv;
  console.log(USAGE);
  return 64;
}
