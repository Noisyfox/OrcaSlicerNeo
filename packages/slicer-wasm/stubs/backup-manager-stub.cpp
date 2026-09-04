// The native BBS backup manager owns a background boost::thread. That worker
// is not part of the synchronous WASM bridge contract. The WASM build patches
// the complete implementation out of bbs_3mf.cpp and links these ABI-
// compatible no-op entry points instead.

#include "libslic3r/Model.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"

namespace Slic3r {

void save_object_mesh(ModelObject&)
{
}

void delete_object_mesh(ModelObject&)
{
}

void backup_soon()
{
}

void remove_backup(Model& model, bool)
{
    // Preserve cleanup of temporary/imported backup directories without
    // constructing _BBS_Backup_Manager.
    model.remove_backup_path_if_exist();
}

void set_backup_interval(long)
{
}

void set_backup_callback(std::function<void(int)>)
{
}

void run_backup_ui_tasks()
{
}

void put_other_changes()
{
}

void clear_other_changes(bool)
{
}

bool has_other_changes(bool)
{
    return false;
}

SaveObjectGaurd::SaveObjectGaurd(ModelObject&)
{
}

SaveObjectGaurd::~SaveObjectGaurd()
{
}

} // namespace Slic3r
