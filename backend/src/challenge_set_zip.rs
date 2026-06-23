use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read, Write},
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;
use zip::{
    ZipArchive, ZipWriter,
    write::{FileOptions, SimpleFileOptions},
};

use crate::models::{CanvasConfig, Challenge, ChallengeSet};

const MANIFEST_PATH: &str = "manifest.json";
const IMAGE_PREFIX: &str = "images/";

#[derive(Debug, Clone)]
pub struct ImportedChallengeSetZip {
    pub manifest: ImportManifest,
    pub images: HashMap<String, ImportedImage>,
}

#[derive(Debug, Clone)]
pub struct ImportedImage {
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportManifest {
    pub name: String,
    pub version: String,
    pub challenges: Vec<ImportChallenge>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportChallenge {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub target_image_path: String,
    pub points: i32,
    pub pass_threshold: f64,
    pub enabled: bool,
    pub order: i32,
    pub canvas: CanvasConfig,
    pub judge_config: Value,
}

impl<'de> Deserialize<'de> for ImportChallenge {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawImportChallenge::deserialize(deserializer)?;
        let target_image_path = match (raw.target_image_path, raw.image_path) {
            (Some(path), _) | (None, Some(path)) => path,
            (None, None) => {
                return Err(serde::de::Error::missing_field("target_image_path"));
            }
        };

        Ok(Self {
            slug: raw.slug,
            title: raw.title,
            description: raw.description,
            target_image_path,
            points: raw.points,
            pass_threshold: raw.pass_threshold,
            enabled: raw.enabled,
            order: raw.order,
            canvas: raw.canvas,
            judge_config: raw.judge_config,
        })
    }
}

#[derive(Debug, Deserialize)]
struct RawImportChallenge {
    slug: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    target_image_path: Option<String>,
    #[serde(default)]
    image_path: Option<String>,
    points: i32,
    pass_threshold: f64,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    order: i32,
    #[serde(default)]
    canvas: CanvasConfig,
    #[serde(default = "default_judge_config")]
    judge_config: Value,
}

#[derive(Debug, Clone)]
pub struct ExportImage {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum ChallengeSetZipError {
    #[error("zip archive is invalid")]
    InvalidZip,
    #[error("manifest.json is missing")]
    MissingManifest,
    #[error("manifest.json is invalid")]
    InvalidManifest,
    #[error("zip entry path is unsafe: {0}")]
    UnsafePath(String),
    #[error("zip image must be under images/: {0}")]
    ImageOutsideDirectory(String),
    #[error("unsupported image type: {0}")]
    UnsupportedImage(String),
    #[error("image is invalid: {0}")]
    InvalidImage(String),
    #[error("duplicate challenge slug: {0}")]
    DuplicateSlug(String),
    #[error("duplicate zip entry: {0}")]
    DuplicateEntry(String),
    #[error("image is missing: {0}")]
    MissingImage(String),
    #[error("failed to build zip archive")]
    BuildZip,
}

pub fn read_import_zip(bytes: &[u8]) -> Result<ImportedChallengeSetZip, ChallengeSetZipError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|_| ChallengeSetZipError::InvalidZip)?;
    let mut manifest_bytes = None;
    let mut images = HashMap::new();
    let mut seen_entries = HashSet::new();

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| ChallengeSetZipError::InvalidZip)?;
        let entry_name = file.name().to_owned();
        if !seen_entries.insert(entry_name.clone()) {
            return Err(ChallengeSetZipError::DuplicateEntry(entry_name));
        }
        validate_zip_path(&entry_name)?;
        if file.is_dir() {
            continue;
        }

        if entry_name == MANIFEST_PATH {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|_| ChallengeSetZipError::InvalidZip)?;
            manifest_bytes = Some(bytes);
            continue;
        }

        if !entry_name.starts_with(IMAGE_PREFIX) {
            return Err(ChallengeSetZipError::ImageOutsideDirectory(entry_name));
        }
        let (content_type, bytes) = read_image(&entry_name, &mut file)?;
        images.insert(
            entry_name,
            ImportedImage {
                content_type,
                bytes,
            },
        );
    }

    let manifest_bytes = manifest_bytes.ok_or(ChallengeSetZipError::MissingManifest)?;
    let manifest: ImportManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| ChallengeSetZipError::InvalidManifest)?;
    validate_manifest(&manifest, &images)?;

    Ok(ImportedChallengeSetZip { manifest, images })
}

pub fn write_export_zip(
    challenge_set: &ChallengeSet,
    challenges: &[Challenge],
    images: &[ExportImage],
) -> Result<Vec<u8>, ChallengeSetZipError> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options: SimpleFileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let manifest = ExportManifest::from_models(challenge_set, challenges);
    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| ChallengeSetZipError::BuildZip)?;

    writer
        .start_file(MANIFEST_PATH, options)
        .map_err(|_| ChallengeSetZipError::BuildZip)?;
    writer
        .write_all(&manifest_bytes)
        .map_err(|_| ChallengeSetZipError::BuildZip)?;

    for image in images {
        validate_zip_path(&image.path)?;
        if !image.path.starts_with(IMAGE_PREFIX) {
            return Err(ChallengeSetZipError::ImageOutsideDirectory(
                image.path.clone(),
            ));
        }
        writer
            .start_file(&image.path, options)
            .map_err(|_| ChallengeSetZipError::BuildZip)?;
        writer
            .write_all(&image.bytes)
            .map_err(|_| ChallengeSetZipError::BuildZip)?;
    }

    let cursor = writer
        .finish()
        .map_err(|_| ChallengeSetZipError::BuildZip)?;
    Ok(cursor.into_inner())
}

fn validate_manifest(
    manifest: &ImportManifest,
    images: &HashMap<String, ImportedImage>,
) -> Result<(), ChallengeSetZipError> {
    if manifest.name.trim().is_empty()
        || manifest.version.trim().is_empty()
        || manifest.challenges.is_empty()
    {
        return Err(ChallengeSetZipError::InvalidManifest);
    }

    let mut slugs = HashSet::new();
    for challenge in &manifest.challenges {
        if challenge.slug.trim().is_empty()
            || challenge.title.trim().is_empty()
            || !challenge.pass_threshold.is_finite()
        {
            return Err(ChallengeSetZipError::InvalidManifest);
        }
        if !slugs.insert(challenge.slug.clone()) {
            return Err(ChallengeSetZipError::DuplicateSlug(challenge.slug.clone()));
        }
        validate_zip_path(&challenge.target_image_path)?;
        if !challenge.target_image_path.starts_with(IMAGE_PREFIX) {
            return Err(ChallengeSetZipError::ImageOutsideDirectory(
                challenge.target_image_path.clone(),
            ));
        }
        if !images.contains_key(&challenge.target_image_path) {
            return Err(ChallengeSetZipError::MissingImage(
                challenge.target_image_path.clone(),
            ));
        }
    }

    Ok(())
}

fn validate_zip_path(path: &str) -> Result<(), ChallengeSetZipError> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(ChallengeSetZipError::UnsafePath(path.to_owned()));
    }
    let parsed = Path::new(path);
    for component in parsed.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(ChallengeSetZipError::UnsafePath(path.to_owned()));
            }
        }
    }
    Ok(())
}

fn read_image<R: Read>(
    path: &str,
    reader: &mut R,
) -> Result<(&'static str, Vec<u8>), ChallengeSetZipError> {
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| ChallengeSetZipError::InvalidZip)?;
    let content_type = content_type_from_path_and_bytes(path, &bytes)
        .ok_or_else(|| ChallengeSetZipError::UnsupportedImage(path.to_owned()))?;
    image::load_from_memory(&bytes)
        .map_err(|_| ChallengeSetZipError::InvalidImage(path.to_owned()))?;
    Ok((content_type, bytes))
}

fn content_type_from_path_and_bytes(path: &str, bytes: &[u8]) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if (lower.ends_with(".jpg") || lower.ends_with(".jpeg")) && bytes.starts_with(&[0xff, 0xd8]) {
        return Some("image/jpeg");
    }
    None
}

fn default_enabled() -> bool {
    true
}

fn default_judge_config() -> Value {
    json!({})
}

#[derive(Debug, Serialize)]
struct ExportManifest {
    name: String,
    version: String,
    challenges: Vec<ImportChallenge>,
}

impl ExportManifest {
    fn from_models(challenge_set: &ChallengeSet, challenges: &[Challenge]) -> Self {
        Self {
            name: challenge_set.name.clone(),
            version: challenge_set.version.clone(),
            challenges: challenges
                .iter()
                .map(|challenge| ImportChallenge {
                    slug: challenge.slug.clone(),
                    title: challenge.title.clone(),
                    description: challenge.description.clone(),
                    target_image_path: challenge
                        .target_image_path
                        .clone()
                        .unwrap_or_else(|| fallback_image_path(challenge)),
                    points: challenge.points,
                    pass_threshold: challenge.pass_threshold,
                    enabled: challenge.enabled,
                    order: challenge.order,
                    canvas: challenge.canvas.clone(),
                    judge_config: challenge.judge_config.clone(),
                })
                .collect(),
        }
    }
}

fn fallback_image_path(challenge: &Challenge) -> String {
    let extension = challenge
        .target_image_asset_id
        .as_deref()
        .and_then(|asset_id| asset_id.rsplit('.').next())
        .filter(|extension| matches!(*extension, "png" | "jpg" | "jpeg"))
        .unwrap_or("png");
    format!("images/{}.{extension}", challenge.slug)
}

pub fn imported_asset_id() -> String {
    format!("challenge-target-{}", Uuid::new_v4())
}
