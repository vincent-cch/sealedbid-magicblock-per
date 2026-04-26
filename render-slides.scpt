on run argv
    set pptxPath to POSIX file (item 1 of argv)
    set outFolder to POSIX file (item 2 of argv)
    tell application "Keynote"
        activate
        open pptxPath
        delay 3
        set thePres to front document
        export thePres to outFolder as slide images with properties {image format:JPEG, all stages:false, skipped slides:false}
        close thePres saving no
        quit
    end tell
end run
