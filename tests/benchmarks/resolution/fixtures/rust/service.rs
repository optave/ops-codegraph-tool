use crate::models::{create_user, Repository, User};
use crate::repository::{create_repository, UserRepository};
use crate::validator::validate_all;

pub struct UserService {
    repo: UserRepository,
}

impl UserService {
    pub fn new(repo: UserRepository) -> Self {
        UserService { repo }
    }

    pub fn get_user(&self, id: u64) -> Option<User> {
        self.repo.find_by_id(id)
    }

    pub fn add_user(&self, id: u64, name: &str, email: &str) -> Result<(), String> {
        let user = create_user(id, name, email);
        validate_all(&user)?;
        self.repo.save(&user)
    }

    pub fn remove_user(&self, id: u64) -> bool {
        self.repo.delete(id)
    }
}

pub fn build_service() -> UserService {
    let repo = create_repository();
    UserService::new(repo)
}
