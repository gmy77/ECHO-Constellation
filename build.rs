//! Incorpora nell'exe l'icona e le informazioni di versione (visibili in Esplora risorse).
fn main() {
    println!("cargo:rerun-if-changed=assets/app.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/app.ico")
            .set("FileDescription", "ECHO Constellation · satelliti in tempo reale")
            .set("ProductName", "ECHO Constellation");
        if let Err(e) = res.compile() {
            println!("cargo:warning=risorse Windows non incorporate: {e}");
        }
    }
}
