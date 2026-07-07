namespace App
{
    public static class Validators
    {
        public static bool ValidateUser(string email)
        {
            return IsValidEmail(email);
        }

        public static bool IsValidEmail(string email)
        {
            return email.Contains("@");
        }
    }

    public static class Formatters
    {
        // Same method name as Validators.IsValidEmail — must NOT cross-resolve.
        public static bool IsValidEmail(string value)
        {
            return false;
        }

        public static string FormatName(string name)
        {
            return name.Trim();
        }
    }
}
