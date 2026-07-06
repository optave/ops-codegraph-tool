#[derive(Clone)]
pub struct User {
    pub id: u64,
    pub name: String,
    pub email: String,
}

impl User {
    pub fn new(id: u64, name: &str, email: &str) -> Self {
        User {
            id,
            name: name.to_string(),
            email: email.to_string(),
        }
    }

    pub fn display_name(&self) -> String {
        format!("{} <{}>", self.name, self.email)
    }
}

pub trait Validator {
    fn validate(&self, user: &User) -> Result<(), String>;
}

pub trait Repository {
    fn find_by_id(&self, id: u64) -> Option<User>;
    fn save(&self, user: &User) -> Result<(), String>;
    fn delete(&self, id: u64) -> bool;
}

fn sanitize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

pub fn create_user(id: u64, name: &str, email: &str) -> User {
    let clean_email = sanitize_email(email);
    User::new(id, name, &clean_email)
}
