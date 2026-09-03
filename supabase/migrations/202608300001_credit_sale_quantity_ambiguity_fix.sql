begin;

-- Hotfix for databases that already applied 202608290001. The PL/pgSQL local
-- variable and inventory_movements column were both named quantity, so the
-- stock aggregation must qualify the table column explicitly.
do $hotfix$
declare
  function_definition text;
  ambiguous_expression constant text := 'sum(quantity)';
  qualified_expression constant text := 'sum(public.inventory_movements.quantity)';
begin
  select pg_get_functiondef(
    'public.create_credit_sale(uuid,uuid,uuid,uuid,uuid,text,jsonb,bigint,date)'::regprocedure
  ) into function_definition;

  if position(ambiguous_expression in function_definition) > 0 then
    execute replace(function_definition, ambiguous_expression, qualified_expression);
  end if;
end;
$hotfix$;

commit;
