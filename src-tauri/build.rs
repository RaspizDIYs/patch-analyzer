use dotenv::dotenv;
use std::env;

fn main() {
    // Load secrets.env file
    dotenv::from_filename("secrets.env").ok();

    // Re-export specific env vars for the compiler
    if let Ok(key) = env::var("SUPABASE_KEY") {
        println!("cargo:rustc-env=SUPABASE_KEY={}", key);
    }
    if let Ok(url) = env::var("SUPABASE_URL") {
        println!("cargo:rustc-env=SUPABASE_URL={}", url);
    }

    tauri_build::build()
}
