const path = require('path');
const { app } = require('electron');

app.whenReady().then(() => {
  const targetScript = process.argv[2];
  if (!targetScript) {
    process.stderr.write('Missing target script for electron runner app\n');
    app.exit(1);
    return;
  }

  const resolvedTargetScript = path.resolve(targetScript);
  const forwardedArgs = process.argv.slice(3);
  process.argv = [process.argv[0], resolvedTargetScript, ...forwardedArgs];

  try {
    require(resolvedTargetScript);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
