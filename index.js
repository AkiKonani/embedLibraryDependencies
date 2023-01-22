import { escapeForRegExp } from '@sanjo/escape-for-reg-exp'
import { readFile } from '@sanjo/read-file'
import { writeFile } from '@sanjo/write-file'
import * as child_process from 'child_process'
import * as fs from 'fs/promises'
import { glob } from 'glob-promise'
import * as path from 'path'
import {
  createLines,
  determineAddOnName,
  doesFileExists,
  filterAsync,
  generateTOCFilePath,
  mergeIncludes,
  removeDuplicates,
  replaceIncludes,
  retrieveIncludes,
  retrieveTOCFilePaths,
  tocFileNameGenerators,
} from './libs/unnamed/packages/lua/index.js'

async function main() {
  const addOnPath = process.argv[2]
  const dependenciesWhichCanBeEmbedded = determineDependenciesWhichCanBeEmbedded(addOnPath)
  await embedDependencies(addOnPath, dependenciesWhichCanBeEmbedded)
}

const libraryFolderName = 'libs'

async function embedDependencies(addOnPath, dependenciesToEmbed) {
  if (dependenciesToEmbed.length >= 1) {
    const repositoryRootPath = path.resolve(addOnPath, path.join('..', '..'))

    const gitModulesContent = await readFile(path.join(repositoryRootPath, '.gitmodules'))
    const gitModuleRegExp = /\[submodule ".+?"\]\n\tpath = (.+?)\nurl = (.+?)\n/sg
    const gitModules = []
    let match
    while (match = gitModuleRegExp.exec(gitModulesContent)) {
      const gitModule = {
        path: match[1],
        url: match[2],
      }
      gitModules.push(gitModule)
    }
    const gitModulesLookup = new Map(gitModules.map(({ path, url }) => [path, url]))

    process.chdir(addOnPath)
    await fs.mkdir(libraryFolderName) // TODO: Might require try catch when directory already exists.
    const relativeAddOnPath = path.relative(repositoryRootPath, addOnPath) // TODO: Does this generate the correct thing?
    const gitRepositoryUrl = gitModulesLookup.get(relativeAddOnPath)
    if (gitRepositoryUrl) {
      child_process.execSync('git submodule add https://github.com/SanjoSolutions/Library.git libs/Library')
      for (const dependencyToEmbed of dependenciesToEmbed) {
        child_process.execSync(`git submodule add ${ gitRepositoryUrl } libs/${ dependenciesToEmbed }`)
      }
      child_process.execSync('git submodule update --init --recursive')
      addRetrieveLibraryStatements(addOnPath)
      addLibraryLoadingToLuaFiles(addOnPath)
      await removeDependencies(addOnPath, dependenciesToEmbed)
    } else {
      throw new Error(`Couldn't find repository url for "${ relativeAddOnPath }".`)
    }
  }
}

function addRetrieveLibraryStatements(addOnPath) {
  for (const tocFileNameGenerator of tocFileNameGenerators) {
    await addRetrieveLibraryStatementsToTOCFile(addOnPath, tocFileNameGenerator)
  }
}

function addLibraryLoadingToLuaFiles(addOnPath) {
  const libraries = retrieveLibraries(addOnPath)
  const luaFilePaths = retrieveNonLibraryLuaFilePathsOfAddOn(addOnPath)
  const addOnName = determineAddOnName(addOnPath)
  for (const luaFilePath of luaFilePaths) {
    addLibraryLoadingToLuaFile(addOnName, luaFilePath, libraries)
  }
}

function retrieveLibraries(addOnPath) {
  const files = await fs.readdir(path.join(addOnPath, libraryFolderName), {withFileTypes: true})
  const libraries = files.filter(file => file.isDirectory()).map(file => file.name)
  return libraries
}

function retrieveNonLibraryLuaFilePathsOfAddOn(addOnPath) {
  const filePaths = await glob('**/*.lua', {
    cwd: addOnPath,
    ignore: 'deps/**/*'
  })
  return filePaths
}

function addLibraryLoadingToLuaFile(addOnName, luaFilePath, libraries) {
  const content = await readFile(luaFilePath)
  const lines = createLines(content)
  const regExpText = libraries.map(({ name }) => escapeForRegExp(name)).join('|')
  const dependenciesThatTheFileDependsOn = []
  const dependenciesThatTheFileDependsOnSet = new Set()
  const firstUsageOfDependency = new Map()
  for (let index = 0; index < lines.length; index++) {
    const regExp = new RegExp(regExpText, 'g')
    const librariesThatTheFileDependsOnInLine = removeDuplicates(content.matchAll(regExp))
    for (const dependency of librariesThatTheFileDependsOnInLine) {
      if (!dependenciesThatTheFileDependsOnSet.has(dependency)) {
        dependenciesThatTheFileDependsOn.push(dependency)
        dependenciesThatTheFileDependsOnSet.add(dependency)
        firstUsageOfDependency.set(dependency, index)
      }
    }
  }

  const libraryVersions = new Map(libraries.map(({ name, version }) => [name, version]))

  function generateLibraryRetrieveCodeLines(dependency) {
    const version = libraryVersions.get(dependency)
    return [
      `--- @type ${ dependency }`,
      `local ${ dependency } = Library.retrieve('${ dependency }', '^${ version }')`,
    ]
  }

  const globalDeclarationLineIndex = lines.findIndex(line => isGlobalDeclarationLine(addOnName, line))

  const linesToAdd = [
    '',
    ...dependenciesThatTheFileDependsOn.flatMap(generateLibraryRetrieveCodeLines),
    '',
  ]

  let addIndex
  if (globalDeclarationLineIndex !== -1) {
    addIndex = globalDeclarationLineIndex
  } else {
    addIndex = 0
  }

  lines.splice(addIndex, 0, linesToAdd)
}

async function removeDependencies(addOnPath, dependenciesToRemove) {
  const tocFilePaths = await retrieveTOCFilePaths(addOnPath)
  return await Promise.all(tocFilePaths.map(tocFilePath => removeDependenciesInTOCFile(tocFilePath, dependenciesToRemove)))
}

async function removeDependenciesInTOCFile(tocFilePath, dependenciesToRemove) {
  dependenciesToRemove = new Set(dependenciesToRemove)
  const dependencies = retrieveDependencies(tocFilePath)
  const newDependencies = dependencies.filter(dependency => !dependenciesToRemove.has(dependency))
  await replaceDependencies(tocFilePath, newDependencies)
}

const dependenciesRegExp = /^## (Dep\w*|RequireDeps): *(.+) *$/m

async function replaceDependencies(tocFilePath, newDependencies) {
  const content = await readFile(tocFilePath)
  const dependenciesList = newDependencies.join(', ')
  const newContent = content.replaceAll(dependenciesRegExp, function (_, label) {
    return `## ${ label }: ${ dependenciesList }`
  })
  await writeFile(tocFilePath, newContent)
}

function isGlobalDeclarationLine(addOnName, line) {
  return line === `${ addOnName } = ${ addOnName } or {}`
}

async function addRetrieveLibraryStatementsToTOCFile(addOnPath, tocFileNameGenerator) {
  const tocFilePath = generateTOCFilePath(addOnPath, tocFileNameGenerator)
  const content = await readFile(tocFilePath)
  const includes = retrieveIncludes(content)
  const dependenciesToEmbed = await determineDependenciesFromTOCFileWhichCanBeEmbedded(addOnPath, tocFilePath)
  const addOnsPath = path.resolve(addOnPath, '..')
  const includesForEmbeds = generateIncludesForEmbeds(tocFilePath, addOnsPath, dependenciesToEmbed)
  const newIncludes = mergeIncludes([...includesForEmbeds, ...includes])
  const newContent = replaceIncludes(content, newIncludes)
  await writeFile(tocFilePath, newContent)
}

function generateIncludesForEmbeds(tocFilePath, addOnsPath, tocFileNameGenerator, dependenciesToEmbed) {
  for (const dependencyToEmbed of dependenciesToEmbed) {
    const dependencyTocFilePath = path.join(addOnsPath, dependencyToEmbed, tocFileNameGenerator(dependencyToEmbed))
    const content = await readFile(dependencyTocFilePath)
    const includes = retrieveIncludes(content)
      .map(include => path.relative(tocFilePath, path.resolve(dependencyTocFilePath, include)))
    return includes
  }
}

async function determineDependenciesWhichCanBeEmbedded(addOnPath) {
  const tocFilePaths = retrieveTOCFilePaths(addOnPath)
  const dependencies = removeDuplicates([].concat(...(await Promise.all(tocFilePaths.map(tocFilePath => determineDependenciesFromTOCFileWhichCanBeEmbedded(
    addOnPath,
    tocFilePath,
  ))))))
  return dependencies
}

async function determineDependenciesFromTOCFileWhichCanBeEmbedded(addOnPath, tocFilePath) {
  const dependencies = await retrieveDependencies(tocFilePath)
  const dependenciesWhichCanBeEmbedded = await filterAsync(
    dependencies,
    dependency => isDependencyWhichCanBeEmbedded(addOnPath, dependency),
  )
  return dependenciesWhichCanBeEmbedded
}

async function isDependencyWhichCanBeEmbedded(addOnPath, dependency) {
  const dependencyPath = path.resolve(addOnPath, path.join('..', dependency))
  return await isAddOnWhichUseLibraryAddOn(dependencyPath)
}

async function retrieveDependencies(tocFilePath) {
  const content = await readFile(tocFilePath)
  const match = dependenciesRegExp.exec(content)
  const dependencies = match ? match[2].split(', ') : []
  return dependencies
}

async function isAddOnWhichUseLibraryAddOn(addOnPath) {
  return await doesFileExists(path.join(addOnPath, libraryFolderName, 'Library'))
}

main()
