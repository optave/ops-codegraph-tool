mod models;
mod repository;
mod service;
mod validator;

use crate::models::{create_user, Repository};
use crate::repository::UserRepository;
use crate::service::build_service;
use crate::validator::validate_all;

fn main() {
    let service = build_service();

    match service.add_user(1, "Alice", "alice@example.com") {
        Ok(()) => println!("Added user 1"),
        Err(e) => println!("Failed to add user: {}", e),
    }

    if let Some(user) = service.get_user(1) {
        println!("Found: {}", user.display_name());
    }

    let removed = service.remove_user(1);
    println!("Removed: {}", removed);

    direct_repo_access();
}

fn direct_repo_access() {
    let repo = UserRepository::new();
    let user = create_user(2, "Bob", "bob@example.com");
    if validate_all(&user).is_ok() {
        let _ = repo.save(&user);
    }
}
