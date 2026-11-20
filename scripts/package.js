'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const output = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
const icon = `extension/${pkg.icon}`;
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/><DisplayName>${pkg.displayName}</DisplayName><Description xml:space="preserve">${pkg.description}</Description><Tags>ai,glm,chat</Tags><Categories>AI,Other</Categories><GalleryFlags>Private</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties><Icon>${icon}</Icon></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="${icon}" Addressable="true"/></Assets>
</PackageManifest>`;
const contentTypes = `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="html" ContentType="text/html"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`;
const payload = { root, output, manifest, contentTypes };
const result = spawnSync('python3', ['-c', `import json,sys,zipfile,pathlib
p=json.load(sys.stdin)
root=pathlib.Path(p['root'])
with zipfile.ZipFile(p['output'],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('extension.vsixmanifest',p['manifest'])
 z.writestr('[Content_Types].xml',p['contentTypes'])
 for name in ['package.json','package-lock.json','extension.js','README.md','src','media','skills','node_modules']:
  item=root/name
  files=item.rglob('*') if item.is_dir() else [item]
  for f in files:
   if f.is_file() and f.suffix != '.map': z.write(f,'extension/'+str(f.relative_to(root)))
`], { input: JSON.stringify(payload), encoding: 'utf8' });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
console.log(output);
