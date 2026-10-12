# tables/

Shared data-table components for the ERP's list/report screens
(sorting, pagination, RTL-aware columns). Built as the modules that
need them arrive in Step 4.

## Default correction actions

Every meaningful user-created row should expose compact, RTL-safe line-icon
actions with Arabic `title` and `aria-label` text. Ordinary unreferenced master
data uses **تعديل** and **حذف**. Posted financial, inventory, production, or
historical rows must instead call a main-process service that decides whether
hard deletion is safe and otherwise cancels, archives, voids, reverses, or
returns a clear Arabic business error. Renderers never infer deletion safety
from row shape and never issue direct database operations.
