# rev1sa-datos

Horarios de transporte público de España (GTFS) en un formato compacto para la app **Rev1sa**. Solo datos: el código de la app no está aquí.

- **Fuentes:** catálogo de [Mobility Database](https://mobilitydatabase.org) (CC0) y el [NAP del Ministerio de Transportes](https://nap.transportes.gob.es) (cada fuente con su licencia).
- **Cada lunes** GitHub Actions lo regenera y lo publica en GitHub Pages:
  - `indice.json`: fuentes, zona que cubren, tipos y fechas.
  - `t/<fila>_<col>.json`: **con conexión**. Celda de 0,25° (fila = ⌊lat/0,25⌋, col = ⌊lon/0,25⌋) con los viajes que paran en ella, 15 días.
  - `f/<id>.json`: **sin conexión** (opcional). La fuente entera, 70 días.
- Fuentes caducadas en origen: se reutiliza su última semana con servicio sobre las fechas actuales (campo `antiguo` = último día real).
- Formato de cada paquete: `paradas` [nombre, estación de tren cercana, lat, lon], `lineas` [nombre, empresa, route_type], `dias` (un 0/1 por día desde `base`), `viajes` [línea, días, [parada, minuto, …]].
