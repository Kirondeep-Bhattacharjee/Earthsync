-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION enforce_dob_rules() RETURNS trigger AS $$
BEGIN
  IF NEW.date_of_birth > (current_date - interval '18 years')::date THEN
    RAISE EXCEPTION 'date_of_birth must be 18 or older';
  END IF;

  IF TG_OP = 'UPDATE' AND (
       NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
       OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'date_of_birth is immutable';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS account_private_dob_rules ON account_private;
--> statement-breakpoint
CREATE TRIGGER account_private_dob_rules
  BEFORE INSERT OR UPDATE ON account_private
  FOR EACH ROW EXECUTE FUNCTION enforce_dob_rules();