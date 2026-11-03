use std::process::Command;

const EXTENSION_SOURCE: &str = "webkit-extension/ogmedia.c";
const EXTENSION_OUTPUT: &str = "gen/webkit-extensions/libogmedia.so";
const EXTENSION_LIBRARIES: [&str; 4] = [
	"webkit2gtk-web-extension-4.1",
	"gstreamer-1.0",
	"gstreamer-base-1.0",
	"gio-unix-2.0",
];

fn main() {
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
		build_webkit_extension();
	}
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		build_apple_intelligence_helper();
	}
	tauri_build::build()
}

fn build_apple_intelligence_helper() {
	const SOURCE: &str = "apple-intelligence/main.swift";
	println!("cargo:rerun-if-changed={SOURCE}");

	let target_dir =
		std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
	let output = target_dir.join("apple-intelligence");
	std::fs::create_dir_all(&target_dir)
		.expect("create Cargo target directory");

	let status = Command::new("xcrun")
		.args([
			"--sdk",
			"macosx",
			"swiftc",
			"-O",
			"-parse-as-library",
			"-target",
			"arm64-apple-macosx26.0",
			"-framework",
			"FoundationModels",
			"-o",
		])
		.arg(&output)
		.arg(SOURCE)
		.status()
		.expect("run xcrun swiftc to build the Apple Intelligence helper");
	assert!(status.success(), "compiling {SOURCE} failed");
	println!(
		"cargo:rustc-env=APPLE_INTELLIGENCE_HELPER={}",
		output.display()
	);
}

fn build_webkit_extension() {
	println!("cargo:rerun-if-changed={EXTENSION_SOURCE}");
	let pkg_config =
		std::env::var("PKG_CONFIG").unwrap_or_else(|_| "pkg-config".to_owned());
	let flags = Command::new(pkg_config)
		.args(["--cflags", "--libs"])
		.args(EXTENSION_LIBRARIES)
		.output()
		.expect("run pkg-config");
	assert!(
		flags.status.success(),
		"pkg-config cannot find {EXTENSION_LIBRARIES:?}: {}",
		String::from_utf8_lossy(&flags.stderr)
	);
	std::fs::create_dir_all("gen/webkit-extensions")
		.expect("create gen/webkit-extensions");
	let status = cc::Build::new()
		.debug(false)
		.get_compiler()
		.to_command()
		.args([
			"-shared",
			"-fPIC",
			"-O2",
			"-Wall",
			"-o",
			EXTENSION_OUTPUT,
			EXTENSION_SOURCE,
		])
		.args(String::from_utf8_lossy(&flags.stdout).split_whitespace())
		.status()
		.expect("run the C compiler");
	assert!(status.success(), "compiling {EXTENSION_SOURCE} failed");
}
