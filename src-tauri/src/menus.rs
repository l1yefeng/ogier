use tauri::{Emitter, menu::Menu};

fn handle_by_emit_event(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    app.emit_to("main", &format!("menu/{id}"), ())
        .map_err(|e| e.to_string())
}

pub mod file {
    use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};

    pub const ID: &str = "f";
    const TEXT: &str = "File";

    pub mod open {
        pub const ID: &str = "f_o";
        pub const TEXT: &str = "Open";
    }
    pub mod open_in_new_window {
        pub const ID: &str = "f_oinw";
        pub const TEXT: &str = "Open in new window";
    }

    pub mod show_in_folder {
        use tauri::Manager;
        use tauri_plugin_opener::OpenerExt;

        pub const ID: &str = "f_sif";
        pub const TEXT: &str = "Show in folder";

        pub fn handle(app: &tauri::AppHandle) -> Result<(), String> {
            let filepath = {
                let state = app.state::<crate::AppState>();
                let state = state.lock().unwrap();
                state.book_file_info.path.clone()
            };
            app.opener()
                .reveal_item_in_dir(filepath)
                .map_err(|e| e.to_string())
        }
    }

    pub mod details {
        pub const ID: &str = "f_d";
        pub const TEXT: &str = "Details";
    }
    pub mod table_of_contents {
        pub const ID: &str = "f_toc";
        pub const TEXT: &str = "Table of contents";
    }

    pub mod open_preference_file {
        use tauri_plugin_opener::OpenerExt;
        use tauri_plugin_store::resolve_store_path;

        pub const ID: &str = "f_opf";
        pub const TEXT: &str = "Open preference file";

        pub fn handle(app: &tauri::AppHandle) -> Result<(), String> {
            let path = resolve_store_path(app, crate::PREFS_STORE).map_err(|e| e.to_string())?;
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())
        }
    }

    pub fn make<R>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>>
    where
        R: tauri::Runtime,
    {
        SubmenuBuilder::new(app, TEXT)
            .id(ID)
            .text(open::ID, open::TEXT)
            .text(open_preference_file::ID, open_preference_file::TEXT)
            .quit()
            .build()
    }

    pub fn update<R>(window: &tauri::Window<R>, submenu: &Submenu<R>) -> tauri::Result<()>
    where
        R: tauri::Runtime,
    {
        submenu.insert_items(
            &[
                &MenuItemBuilder::new(open_in_new_window::TEXT)
                    .id(open_in_new_window::ID)
                    .build(window)?,
                &PredefinedMenuItem::separator(window)?,
                &MenuItemBuilder::new(show_in_folder::TEXT)
                    .id(show_in_folder::ID)
                    .build(window)?,
                &MenuItemBuilder::new(details::TEXT)
                    .id(details::ID)
                    .build(window)?,
                &MenuItemBuilder::new(table_of_contents::TEXT)
                    .id(table_of_contents::ID)
                    .build(window)?,
                &PredefinedMenuItem::separator(window)?,
            ],
            1,
        )
    }
}

pub mod view {
    use tauri::menu::{Submenu, SubmenuBuilder};

    pub const ID: &str = "v";
    const TEXT: &str = "View";

    pub mod font_preference {
        use tauri::{
            Emitter,
            menu::{Submenu, SubmenuBuilder},
        };
        use tauri_plugin_store::StoreExt;

        use crate::prefs::FontPrefer;

        pub const ID: &str = "v_fp";
        const TEXT: &str = "Font preference";

        pub fn handle(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
            // ensure at most one is checked
            let menu = app
                .menu()
                .unwrap()
                .get(crate::menus::view::ID)
                .unwrap()
                .as_submenu_unchecked()
                .get(ID)
                .unwrap();
            let menu = menu.as_submenu_unchecked();
            let menu_item = menu.get(id).unwrap();
            let menu_item = menu_item.as_check_menuitem_unchecked();
            let font_pref = if menu_item.is_checked().map_err(|e| e.to_string())? {
                Some(if id == serif::ID {
                    FontPrefer::Serif
                } else {
                    FontPrefer::SansSerif
                })
            } else {
                None
            };
            set(&menu, font_pref).map_err(|e| e.to_string())
        }

        pub mod sans_serif {
            pub const ID: &str = "v_fp_ss";
            pub(super) const TEXT: &str = "Sans-serif";
        }
        pub mod serif {
            pub const ID: &str = "v_fp_s";
            pub(super) const TEXT: &str = "Serif";
        }

        pub fn make<R, M>(manager: &M) -> tauri::Result<Submenu<R>>
        where
            R: tauri::Runtime,
            M: tauri::Manager<R>,
        {
            SubmenuBuilder::new(manager, TEXT)
                .id(ID)
                .check(sans_serif::ID, sans_serif::TEXT)
                .check(serif::ID, serif::TEXT)
                .build()
        }

        pub fn set<R>(
            submenu: &Submenu<R>,
            value: Option<FontPrefer>,
        ) -> Result<(), crate::error::Error>
        where
            R: tauri::Runtime,
        {
            let (sans_checked, serif_checked) = match value {
                Some(FontPrefer::SansSerif) => (true, false),
                Some(FontPrefer::Serif) => (false, true),
                None => (false, false),
            };
            submenu
                .get(sans_serif::ID)
                .unwrap()
                .as_check_menuitem_unchecked()
                .set_checked(sans_checked)?;
            submenu
                .get(serif::ID)
                .unwrap()
                .as_check_menuitem_unchecked()
                .set_checked(serif_checked)?;

            let json_value = match value {
                Some(FontPrefer::SansSerif) => serde_json::json!("sans-serif"),
                Some(FontPrefer::Serif) => serde_json::json!("serif"),
                None => serde_json::Value::Null,
            };
            // save prefs
            let prefs_store = submenu.app_handle().store(crate::PREFS_STORE)?;
            prefs_store.set("font.prefer", json_value.clone());

            // notify the front-end
            submenu
                .app_handle()
                .emit_to("main", &format!("menu/{}", ID), json_value)?;

            Ok(())
        }
    }

    pub mod open_custom_styles {
        use tauri::Manager;
        use tauri_plugin_opener::OpenerExt;

        pub const ID: &str = "v_ocs";
        pub(super) const TEXT: &str = "Open custom styles";

        pub fn handle(app: &tauri::AppHandle) -> Result<(), String> {
            let state = app.state();
            let Ok(css_path) = crate::custom_stylesheet_path(&app, &state) else {
                return Err(String::from("failed to obtain custom styles file"));
            };
            app.opener()
                .open_path(css_path.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())
        }
    }

    pub fn make<R>(window: &tauri::Window<R>) -> tauri::Result<Submenu<R>>
    where
        R: tauri::Runtime,
    {
        SubmenuBuilder::new(window, TEXT)
            .id(ID)
            .item(&font_preference::make(window)?)
            .text(open_custom_styles::ID, open_custom_styles::TEXT)
            .build()
    }
}

pub mod help {
    use tauri::menu::{Submenu, SubmenuBuilder};

    pub const ID: &str = "h";
    const TEXT: &str = "Help";

    pub mod version {
        pub const ID: &str = "h_v";
        pub(super) const TEXT: &str = "Version: 0.0.0";
    }

    pub mod website_support {
        use tauri_plugin_opener::OpenerExt;

        pub const ID: &str = "h_ws";
        pub(super) const TEXT: &str = "Website && Support";

        pub fn handle(app: &tauri::AppHandle) -> Result<(), String> {
            app.opener()
                .open_url("https://lyfeng.xyz/ogier", None::<&str>)
                .map_err(|e| e.to_string())
        }
    }

    pub mod license_copyrights {
        use tauri::menu::{AboutMetadata, AboutMetadataBuilder};

        pub(super) const TEXT: &str = "License && Copyrights";
        const COMMENTS: &str = "Ogier: a fast and simple EPUB reader (freeware)";
        const COPYRIGHTS: &str = "Copyright 2025, Ogier EPUB Reader developers";

        pub(super) fn make_metadata<'a>() -> AboutMetadata<'a> {
            AboutMetadataBuilder::new()
                .comments(Some(COMMENTS))
                .copyright(Some(COPYRIGHTS))
                .build()
        }
    }

    pub fn make<R>(app: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>>
    where
        R: tauri::Runtime,
    {
        SubmenuBuilder::new(app, TEXT)
            .id(ID)
            .text(version::ID, version::TEXT)
            .text(website_support::ID, website_support::TEXT)
            .about_with_text(
                license_copyrights::TEXT,
                Some(license_copyrights::make_metadata()),
            )
            .build()
    }
}

pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    match id {
        file::open_in_new_window::ID => Ok(()),
        file::open::ID | file::show_in_folder::ID => file::show_in_folder::handle(app),
        file::details::ID | file::table_of_contents::ID => handle_by_emit_event(app, id),
        file::open_preference_file::ID => file::open_preference_file::handle(app),

        view::font_preference::sans_serif::ID | view::font_preference::serif::ID => {
            view::font_preference::handle(app, id)
        }
        view::open_custom_styles::ID => view::open_custom_styles::handle(app),

        help::version::ID => Ok(()),
        help::website_support::ID => help::website_support::handle(app),

        _ => Err(String::from("Unexpected event")),
    }
}

pub fn make<R>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>>
where
    R: tauri::Runtime,
{
    let menu = Menu::new(app)?;
    let file_submenu = file::make(app)?;
    let help_submenu = help::make(app)?;
    menu.append_items(&[&file_submenu, &help_submenu])?;
    Ok(menu)
}

pub fn update<R>(window: &tauri::Window<R>) -> tauri::Result<Menu<R>>
where
    R: tauri::Runtime,
{
    let menu = window.menu().unwrap();
    if menu.get(view::ID).is_some() {
        return Ok(menu);
    }

    // File
    let file_submenu = menu.get(file::ID).unwrap();
    file::update(window, file_submenu.as_submenu_unchecked())?;

    // View
    let view_submenu = view::make(window)?;
    menu.insert(&view_submenu, 1)?;

    Ok(menu)
}
