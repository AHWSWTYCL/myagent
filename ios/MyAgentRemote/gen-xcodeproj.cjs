/**
 * Generate Xcode project for MyAgentRemote iOS app.
 * Usage: node gen-xcodeproj.cjs
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const genId = () => crypto.randomUUID().toUpperCase().replace(/-/g, '').slice(0, 24)
const tabs = (n, s) => '\t'.repeat(n) + s

// ── UUIDs ──────────────────────────────────────────────────────────────
const ids = {}
const id = (key) => { ids[key] = genId(); return ids[key] }

const PROJECT       = id('project')
const MAIN_GROUP    = id('mainGroup')
const PRODUCTS_GRP  = id('productsGroup')
const SOURCES_GRP   = id('sourcesGroup')
const TARGET        = id('target')
const CONFIG_LIST   = id('configList')
const CONFIG_DEBUG  = id('configDebug')
const CONFIG_RELEASE = id('configRelease')
const SRC_PHASE     = id('srcPhase')
const FRAMEWORKS    = id('frameworks')
const RESOURCES     = id('resources')
const PRODUCT       = id('product')

const DIR = 'MyAgentRemote'
const swiftFiles = ['MyAgentRemoteApp.swift', 'ContentView.swift', 'RemoteClient.swift', 'Models.swift']

// Generate refs/builds for each swift file
const fileRefs = swiftFiles.map(name => ({ name, ref: id(name + 'Ref'), build: id(name + 'Build') }))

// ── pbxproj ────────────────────────────────────────────────────────────
const pbxproj = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
${fileRefs.map(f => tabs(2, `${f.build} /* ${f.name} in Sources */ = {isa = PBXBuildFile; fileRef = ${f.ref} /* ${f.name} */; };`)).join('\n')}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${fileRefs.map(f => tabs(2, `${f.ref} /* ${f.name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "${f.name}"; sourceTree = "<group>"; };`)).join('\n')}
${tabs(2, PRODUCT)} /* ${DIR}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "${DIR}.app"; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
${tabs(2, FRAMEWORKS)} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
${tabs(2, MAIN_GROUP)} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${SOURCES_GRP} /* ${DIR} */,
\t\t\t\t${PRODUCTS_GRP} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
${tabs(2, SOURCES_GRP)} /* ${DIR} */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${fileRefs.map(f => tabs(4, `${f.ref} /* ${f.name} */,`)).join('\n')}
\t\t\t);
\t\t\tpath = ${DIR};
\t\t\tsourceTree = "<group>";
\t\t};
${tabs(2, PRODUCTS_GRP)} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${PRODUCT} /* ${DIR}.app */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
${tabs(2, TARGET)} /* ${DIR} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${CONFIG_LIST} /* Build configuration list for PBXNativeTarget "${DIR}" */;
\t\t\tbuildPhases = (
\t\t\t\t${SRC_PHASE} /* Sources */,
\t\t\t\t${FRAMEWORKS} /* Frameworks */,
\t\t\t\t${RESOURCES} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ${DIR};
\t\t\tproductName = ${DIR};
\t\t\tproductReference = ${PRODUCT} /* ${DIR}.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
${tabs(2, PROJECT)} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1600;
\t\t\t\tLastUpgradeCheck = 1600;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${TARGET} = { CreatedOnToolsVersion = 16.0; };
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${CONFIG_LIST} /* Build configuration list for PBXProject "${DIR}" */;
\t\t\tcompatibilityVersion = "Xcode 15.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (en, Base);
\t\t\tmainGroup = ${MAIN_GROUP};
\t\t\tproductRefGroup = ${PRODUCTS_GRP} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${TARGET} /* ${DIR} */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
${tabs(2, RESOURCES)} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
${tabs(2, SRC_PHASE)} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${fileRefs.map(f => tabs(4, `${f.build} /* ${f.name} in Sources */,`)).join('\n')}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
${tabs(2, CONFIG_DEBUG)} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_KEY_NSAppTransportSecurity = "<dict><key>NSAllowsArbitraryLoads</key><true/></dict>";
\t\t\t\tINFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
\t\t\t\tINFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
\t\t\t\tINFOPLIST_KEY_UILaunchScreen_Generation = YES;
\t\t\t\tINFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
\t\t\t\tINFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = ("\\$(inherited)", "@executable_path/Frameworks");
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.myagent.remote;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Debug;
\t\t};
${tabs(2, CONFIG_RELEASE)} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_KEY_NSAppTransportSecurity = "<dict><key>NSAllowsArbitraryLoads</key><true/></dict>";
\t\t\t\tINFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
\t\t\t\tINFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
\t\t\t\tINFOPLIST_KEY_UILaunchScreen_Generation = YES;
\t\t\t\tINFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
\t\t\t\tINFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = ("\\$(inherited)", "@executable_path/Frameworks");
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.myagent.remote;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
${tabs(2, CONFIG_LIST)} /* Build configuration list for PBXNativeTarget "${DIR}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${CONFIG_DEBUG} /* Debug */,
\t\t\t\t${CONFIG_RELEASE} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */

\t};
\trootObject = ${PROJECT} /* Project object */;
}
`

// ── Write project ───────────────────────────────────────────────────────
const projectDir = path.join(__dirname, `${DIR}.xcodeproj`)
fs.mkdirSync(projectDir, { recursive: true })
fs.writeFileSync(path.join(projectDir, 'project.pbxproj'), pbxproj, 'utf8')

// xcshareddata
const sharedDir = path.join(projectDir, 'xcshareddata')
fs.mkdirSync(sharedDir, { recursive: true })
fs.writeFileSync(path.join(sharedDir, 'IDEWorkspaceChecks.plist'),
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>\n\t<key>IDEDidComputeMac32BitWarning</key>\n\t<true/>\n</dict>\n</plist>\n`)

// xcscheme
const schemesDir = path.join(sharedDir, 'xcschemes')
fs.mkdirSync(schemesDir, { recursive: true })
fs.writeFileSync(path.join(schemesDir, `${DIR}.xcscheme`),
`<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
<BuildActionEntries>
<BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${TARGET}" BuildableName="${DIR}.app" BlueprintName="${DIR}" ReferencedContainer="container:${DIR}.xcodeproj"/>
</BuildActionEntry>
</BuildActionEntries>
</BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
<BuildableProductRunnable runnableDebuggingMode="0">
<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${TARGET}" BuildableName="${DIR}.app" BlueprintName="${DIR}" ReferencedContainer="container:${DIR}.xcodeproj"/>
</BuildableProductRunnable>
</LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">
<BuildableProductRunnable runnableDebuggingMode="0">
<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${TARGET}" BuildableName="${DIR}.app" BlueprintName="${DIR}" ReferencedContainer="container:${DIR}.xcodeproj"/>
</BuildableProductRunnable>
</ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/>
<ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>\n`)

console.log(`✅ Generated ${DIR}.xcodeproj/ (${swiftFiles.length} Swift files)`)
console.log(`   Open: open ios/MyAgentRemote/${DIR}.xcodeproj`)
console.log(`   Build: cd ios/MyAgentRemote && xcodebuild -project ${DIR}.xcodeproj -scheme ${DIR} -destination 'platform=iOS Simulator,name=iPhone 16' build`)
