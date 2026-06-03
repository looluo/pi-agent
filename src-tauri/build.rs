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

    let pack_path = out_dir.join("embedded_assets.pack");
    let mut pack = File::create(&pack_path)?;
    pack.write_all(b"PIAPACK1")?;
    pack.write_all(&(files.len() as u32 + 1).to_le_bytes())?;
    write_packed_file(&mut pack, if target_triple.contains("windows") { "node/pi-agent-node.exe" } else { "node/pi-agent-node" }, &node_path)?;
    for (relative, absolute) in files {
        write_packed_file(&mut pack, &format!("webapp/{relative}"), Path::new(&absolute))?;
    }

    let output_path = out_dir.join("embedded_assets.rs");
    let mut output = File::create(output_path)?;
    writeln!(output, "pub const EMBEDDED_ASSETS: &[u8] = include_bytes!({:?}) as &[u8];", pack_path)?;
    Ok(())
}

fn write_packed_file(pack: &mut File, relative: &str, path: &Path) -> io::Result<()> {
    let bytes = fs::read(path)?;
    let relative = relative.as_bytes();
    pack.write_all(&(relative.len() as u32).to_le_bytes())?;
    pack.write_all(&(bytes.len() as u64).to_le_bytes())?;
    pack.write_all(relative)?;
    pack.write_all(&bytes)?;
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
