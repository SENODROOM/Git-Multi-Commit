#!/usr/bin/env node
import { main } from '../src/cli.js';

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    // Inquirer throws this when the user hits Ctrl-C at a prompt.
    if (err?.name === 'ExitPromptError') {
      console.log('\nCancelled.');
      process.exitCode = 130;
      return;
    }
    console.error(`error: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
