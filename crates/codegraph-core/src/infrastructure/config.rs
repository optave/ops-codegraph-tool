//! Build configuration deserialization.
//!
//! The JS side serializes the relevant config subset to JSON and passes it
//! to `build_graph()`. This avoids reimplementing `.codegraphrc.json` loading,
//! env overrides, and secret resolution in Rust.

use serde::Deserialize;

/// Subset of CodegraphConfig relevant to the build pipeline.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildConfig {
    /// Glob patterns limiting which source files are included.
    /// When non-empty, a file must match at least one pattern.
    /// Matched against paths relative to the project root.
    #[serde(default)]
    pub include: Vec<String>,

    /// Glob patterns excluding source files from the build.
    /// Matched against paths relative to the project root.
    #[serde(default)]
    pub exclude: Vec<String>,

    /// Additional directory names to ignore during file collection.
    #[serde(default)]
    pub ignore_dirs: Vec<String>,

    /// Build-specific settings.
    #[serde(default)]
    pub build: BuildSettings,

    /// Config-level path aliases (merged with tsconfig aliases).
    #[serde(default)]
    pub aliases: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSettings {
    /// Whether incremental builds are enabled (default: true).
    #[serde(default = "default_true")]
    pub incremental: bool,

    /// Drift detection threshold for incremental builds.
    #[serde(default = "default_drift_threshold")]
    pub drift_threshold: f64,
}

// Manual impl so `BuildSettings::default()` matches the serde field defaults.
// `#[derive(Default)]` would give `incremental: false`, which disagrees with
// `#[serde(default = "default_true")]` when the outer `build` key is absent.
impl Default for BuildSettings {
    fn default() -> Self {
        Self {
            incremental: default_true(),
            drift_threshold: default_drift_threshold(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_drift_threshold() -> f64 {
    0.1
}

/// Build options passed from the JS caller.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildOpts {
    /// Engine preference: "native", "wasm", or "auto".
    #[serde(default)]
    pub engine: Option<String>,

    /// Whether to run incremental build (default: true).
    #[serde(default)]
    pub incremental: Option<bool>,

    /// Whether to include dataflow analysis.
    #[serde(default)]
    pub dataflow: Option<bool>,

    /// Whether to include AST node storage.
    #[serde(default)]
    pub ast: Option<bool>,

    /// Whether to include complexity metrics.
    #[serde(default)]
    pub complexity: Option<bool>,

    /// Whether to include CFG analysis.
    #[serde(default)]
    pub cfg: Option<bool>,

    /// Scoped rebuild: only rebuild these files.
    #[serde(default)]
    pub scope: Option<Vec<String>>,

    /// Skip reverse dependency detection.
    #[serde(default)]
    pub no_reverse_deps: Option<bool>,
}

/// Path aliases (from tsconfig.json / jsconfig.json + config overrides).
/// This mirrors the napi PathAliases type but uses serde for JSON deserialization.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildPathAliases {
    #[serde(default)]
    pub base_url: Option<String>,

    #[serde(default)]
    pub paths: std::collections::HashMap<String, Vec<String>>,
}

impl BuildPathAliases {
    /// Convert to the napi PathAliases type used by import_resolution.
    pub fn to_napi_aliases(&self) -> crate::types::PathAliases {
        crate::types::PathAliases {
            base_url: self.base_url.clone(),
            paths: self
                .paths
                .iter()
                .map(|(k, v)| crate::types::AliasMapping {
                    pattern: k.clone(),
                    targets: v.clone(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_empty_config() {
        let config: BuildConfig = serde_json::from_str("{}").unwrap();
        assert!(config.ignore_dirs.is_empty());
        assert!(config.include.is_empty());
        assert!(config.exclude.is_empty());
        assert!(config.build.incremental);
    }

    #[test]
    fn deserialize_full_config() {
        let json = r#"{
            "include": ["src/**/*.ts"],
            "exclude": ["**/*.test.ts", "**/*.spec.ts"],
            "ignoreDirs": ["vendor", "tmp"],
            "build": {
                "incremental": false,
                "driftThreshold": 0.2
            },
            "aliases": {
                "@/": "src/"
            }
        }"#;
        let config: BuildConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.include, vec!["src/**/*.ts"]);
        assert_eq!(config.exclude, vec!["**/*.test.ts", "**/*.spec.ts"]);
        assert_eq!(config.ignore_dirs, vec!["vendor", "tmp"]);
        assert!(!config.build.incremental);
        assert_eq!(config.build.drift_threshold, 0.2);
        assert_eq!(config.aliases.get("@/").unwrap(), "src/");
    }

    #[test]
    fn deserialize_opts() {
        let json = r#"{"engine": "native", "dataflow": true, "scope": ["src/a.ts"]}"#;
        let opts: BuildOpts = serde_json::from_str(json).unwrap();
        assert_eq!(opts.engine.as_deref(), Some("native"));
        assert_eq!(opts.dataflow, Some(true));
        assert_eq!(opts.scope.as_ref().unwrap().len(), 1);
    }
}
