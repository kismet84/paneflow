module.exports = async context => {
  const { prepareInstaller } = await import('../scripts/prepare-nsis-template.mjs');
  await prepareInstaller(context.appOutDir);
};
