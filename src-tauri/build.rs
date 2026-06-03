use std::{
    env,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

fn main() {
    generate_embedded_assets().expect("failed to generate embedded asset manifest");
    tauri_build::build()
}

fn generate_embedded_assets() -> io::Result<()> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR missing"));
    let webapp_dir = manifest_dir.join("resources").join("webapp");
    let target_triple = env::var("TARGET").expect("TARGET missing");
    let node_name = if target_triple.contains("windows") {
        format!("pi-agent-node-{target_triple}.exe")
    } else {
        format!("pi-agent-node-{target_triple}")
    };
    let node_path = manifest_dir.join("binaries").join(node_name);

    println!("cargo:rerun-if-changed={}", webapp_dir.display());
    println!("cargo:rerun-if-changed={}", node_path.display());

    let mut files = Vec::new();
    if webapp_dir.exists() {
        collect_files(&webapp_dir, &webapp_dir, &mut files)?;
    }
    files.sort();

    let output_path = out_dir.join("embedded_assets.rs");
    let mut output = File::create(output_path)?;
    writeln!(output, "pub const EMBEDDED_WEBAPP_FILES: &[(&str, &[u8])] = &[")?;
    for (relative, absolute) in files {
        writeln!(
            output,
            "    ({relative:?}, include_bytes!({absolute:?}) as &[u8]),"
        )?;
    }
    writeln!(output, "];")?;
    writeln!(output, "pub const EMBEDDED_NODE: &[u8] = include_bytes!({:?}) as &[u8];", node_path)?;
    Ok(())
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("file should be under root")
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.push((relative, path.to_string_lossy().into_owned()));
        }
    }
    Ok(())
}
