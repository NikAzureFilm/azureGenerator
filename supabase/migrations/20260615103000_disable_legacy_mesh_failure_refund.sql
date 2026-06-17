CREATE OR REPLACE FUNCTION public.handle_mesh_status_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Mesh failures are refunded by the edge functions with the actual
    -- model-specific charge. The legacy trigger refunded the generic SQL
    -- mesh cost, which double-refunded Max Quality failures.
    RETURN NEW;
END;
$function$;
