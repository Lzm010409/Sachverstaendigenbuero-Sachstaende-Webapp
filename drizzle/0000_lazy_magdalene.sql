CREATE TABLE "fall" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"deal_id" integer,
	"aufgabe_id" integer,
	"status" text,
	"entscheidung" text,
	"entschieden_am" timestamp with time zone,
	"eingereiht_am" timestamp with time zone,
	"analysiert_am" timestamp with time zone,
	"braucht_entwurf" boolean DEFAULT false NOT NULL,
	"fingerabdruck" text,
	"phase_id" integer,
	"phase_name" text,
	"daten" jsonb NOT NULL,
	"aktualisiert_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nacharbeit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"fall_id" text,
	"deal_id" integer,
	"aufgabe_id" integer,
	"token" text,
	"notiz_offen" boolean DEFAULT false NOT NULL,
	"aufgabe_offen" boolean DEFAULT false NOT NULL,
	"versuche" integer DEFAULT 0 NOT NULL,
	"naechster_versuch" timestamp with time zone,
	"daten" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lauf" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"letzter_lauf" timestamp with time zone,
	"zusammenfassung" jsonb,
	"lauf_gemacht_am" text,
	"digest_gesendet_am" text
);
--> statement-breakpoint
CREATE TABLE "verzeichnis_organisation" (
	"schluessel" text PRIMARY KEY NOT NULL,
	"schluessel_art" text NOT NULL,
	"org_id" integer,
	"org_name" text
);
--> statement-breakpoint
CREATE TABLE "verzeichnis_adresse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_schluessel" text NOT NULL,
	"email" text NOT NULL,
	"person" text,
	"anzahl" integer DEFAULT 0 NOT NULL,
	"zuletzt_gesehen" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "verzeichnis_adresse" ADD CONSTRAINT "verzeichnis_adresse_organisation_schluessel_verzeichnis_organisation_schluessel_fk" FOREIGN KEY ("organisation_schluessel") REFERENCES "public"."verzeichnis_organisation"("schluessel") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fall_token_idx" ON "fall" USING btree ("token");--> statement-breakpoint
CREATE INDEX "fall_entscheidung_idx" ON "fall" USING btree ("entscheidung");--> statement-breakpoint
CREATE INDEX "fall_entschieden_am_idx" ON "fall" USING btree ("entschieden_am");--> statement-breakpoint
CREATE INDEX "nacharbeit_reihenfolge_idx" ON "nacharbeit" USING btree ("reihenfolge");--> statement-breakpoint
CREATE INDEX "verzeichnis_adresse_org_idx" ON "verzeichnis_adresse" USING btree ("organisation_schluessel");--> statement-breakpoint
CREATE UNIQUE INDEX "verzeichnis_adresse_org_email_idx" ON "verzeichnis_adresse" USING btree ("organisation_schluessel","email");