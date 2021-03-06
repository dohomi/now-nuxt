const {
  createLambda
} = require('@now/build-utils/lambda.js')
const download = require('@now/build-utils/fs/download.js')
const FileFsRef = require('@now/build-utils/file-fs-ref.js')
// const FileBlob = require('@now/build-utils/file-blob')
const path = require('path')
const {
  readFile,
  writeFile,
  unlink
} = require('fs.promised')
const {
  runNpmInstall,
  runPackageJsonScript
} = require('@now/build-utils/fs/run-user-scripts.js')
const glob = require('@now/build-utils/fs/glob.js')
const {
  // excludeFiles,
  validateEntrypoint,
  includeOnlyEntryDirectory,
  moveEntryDirectoryToRoot,
  // excludeLockFiles,
  normalizePackageJson,
  excludeStaticDirectory,
  onlyStaticDirectory
} = require('./utils')

/** @typedef { import('@now/build-utils/file-ref').Files } Files */
/** @typedef { import('@now/build-utils/fs/download').DownloadedFiles } DownloadedFiles */

/**
 * @typedef {Object} BuildParamsType
 * @property {Files} files - Files object
 * @property {string} entrypoint - Entrypoint specified for the builder
 * @property {string} workPath - Working directory for this build
 */

/**
 * Read package.json from files
 * @param {DownloadedFiles} files
 */
async function readPackageJson (files) {
  if (!files['package.json']) {
    return {}
  }

  const packageJsonPath = files['package.json'].fsPath
  return JSON.parse(await readFile(packageJsonPath, 'utf8'))
}

/**
 * Write package.json
 * @param {string} workPath
 * @param {Object} packageJson
 */
async function writePackageJson (workPath, packageJson) {
  await writeFile(
    path.join(workPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  )
}

/**
 * Write .npmrc with npm auth token
 * @param {string} workPath
 * @param {string} token
 */
async function writeNpmRc (workPath, token) {
  await writeFile(
    path.join(workPath, '.npmrc'),
    `//registry.npmjs.org/:_authToken=${token}`
  )
}

exports.config = {
  maxLambdaSize: '5mb'
}

/**
 * @param {BuildParamsType} buildParams
 * @returns {Promise<Files>}
 */
exports.build = async ({files, workPath, entrypoint}) => {
  console.log('entrypoint ', entrypoint)
  validateEntrypoint(entrypoint)

  console.log('downloading user files...')
  const entryDirectory = path.dirname(entrypoint)
  const filesOnlyEntryDirectory = includeOnlyEntryDirectory(
    files,
    entryDirectory
  )
  const filesWithEntryDirectoryRoot = moveEntryDirectoryToRoot(
    filesOnlyEntryDirectory,
    entryDirectory
  )


  // const filesWithoutLockfiles = excludeLockFiles(filesWithEntryDirectoryRoot)
  // const downloadedFiles = await download(filesWithoutLockfiles, workPath)

  // changed...
  const filesWithoutStaticDirectory = excludeStaticDirectory(
    filesWithEntryDirectoryRoot
  )
  const downloadedFiles = await download(filesWithoutStaticDirectory, workPath)

  console.log('normalizing package.json')
  const packageJson = normalizePackageJson(
    await readPackageJson(downloadedFiles)
  )
  console.log('normalized package.json result: ', packageJson)
  await writePackageJson(workPath, packageJson)

  if (process.env.NPM_AUTH_TOKEN) {
    console.log('found NPM_AUTH_TOKEN in environment, creating .npmrc')
    await writeNpmRc(workPath, process.env.NPM_AUTH_TOKEN)
  }

  console.log('running npm install...')
  await runNpmInstall(workPath, ['--prefer-offline'])
  console.log('running user script...')
  await runPackageJsonScript(workPath, 'now-build')
  console.log('running npm install --production...')
  await runNpmInstall(workPath, ['--prefer-offline', '--production'])
  if (process.env.NPM_AUTH_TOKEN) {
    await unlink(path.join(workPath, '.npmrc'))
  }

  //////
  const lambdas = {}
  console.log('preparing lambda files...')
  const launcherFiles = {
    'now__bridge.js': new FileFsRef({fsPath: require('@now/node-bridge')}),
    'now__launcher.js': new FileFsRef({
      fsPath: path.join(__dirname, 'launcher.js')
    })
  }
  const pages = await glob(
    '**/*.js',
    path.join(workPath, '.nuxt', 'dist', 'client', 'pages')
  )

  const pageKeys = Object.keys(pages)

  if (pageKeys.length === 0) {
    throw new Error(
      'No serverless pages were built. https://err.sh/zeit/now-builders/now-next-no-serverless-pages-built'
    )
  }

  await Promise.all(
    pageKeys.map(async (page) => {
      // These default pages don't have to be handled as they'd always 404
      if (['_app.js', '_error.js', '_document.js'].includes(page)) {
        return
      }

      const pathname = page.replace(/\.js$/, '')

      console.log(`Creating lambda for page: "${page}"...`)
      lambdas[path.join(entryDirectory, pathname)] = await createLambda({
        files: {
          ...launcherFiles,
          'page.js': pages[page]
        },
        handler: 'now__launcher.launcher',
        runtime: 'nodejs8.10'
      })
      console.log(`Created lambda for page: "${page}"`)
    })
  )

  const nuxtStaticFiles = await glob(
    '**',
    path.join(workPath, '.nuxt', 'dist', 'client')
  )

  const staticFiles = Object.keys(nuxtStaticFiles).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, `_nuxt/${file}`)]: nuxtStaticFiles[file]
    }), {}
  )


  const nuxtStaticDirectory = onlyStaticDirectory(filesWithEntryDirectoryRoot)
  const staticDirectoryFiles = Object.keys(nuxtStaticDirectory).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, file)]: nuxtStaticDirectory[file]
    }),
    {}
  )

  return {...lambdas, ...staticFiles, ...staticDirectoryFiles}
}
