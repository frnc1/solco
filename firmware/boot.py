# SOLCO — boot.py (CircuitPython 9 o 10, Raspberry Pi Pico H con RP2040)
# Dà un nome riconoscibile alla scheda e lascia solo ciò che serve:
# MIDI per il tablet, il disco CIRCUITPY per aggiornare i file, la console seriale.
import supervisor
import usb_hid
import usb_midi

try:
    supervisor.set_usb_identification(manufacturer="SOLCO", product="SOLCO Jog")
except Exception:
    pass

try:
    usb_midi.set_names(
        streaming_interface_name="SOLCO Jog",
        audio_control_interface_name="SOLCO Jog",
        in_jack_name="SOLCO in",
        out_jack_name="SOLCO out",
    )
except Exception:
    pass

try:
    usb_hid.disable()  # tastiera/mouse virtuali non servono
except Exception:
    pass

usb_midi.enable()
