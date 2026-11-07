using System.Runtime.InteropServices;
using ComDataObject = System.Runtime.InteropServices.ComTypes.IDataObject;

namespace AudioXtractor;

// Keep the native HRESULT: Control.DoDragDrop turns OLE failures into None,
// which is indistinguishable from a user cancelling the gesture.
public static class OleDrag
{
    [ComVisible(true), Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDropSource
    {
        [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape, uint keys);
        [PreserveSig] int GiveFeedback(uint effect);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class Source(Func<bool, bool> cancel, Func<bool> held) : IDropSource
    {
        public int Queries { get; private set; }
        public int QueryContinueDrag(bool escape, uint keys)
        {
            Queries++;
            return cancel(escape) ? 0x40101 : held() ? 0 : 0x40100;
        }
        public int GiveFeedback(uint effect) => 0x40102;
    }

    public static (int Result, uint Effect, int Queries) Run(string[] files, Func<bool, bool> cancel, Func<bool> held)
    {
        var source = new Source(cancel, held);
        var data = new DataObject(DataFormats.FileDrop, files);
        var result = DoDragDrop((ComDataObject)data, source, 1, out var effect);
        GC.KeepAlive(data); GC.KeepAlive(source);
        return (result, effect, source.Queries);
    }

    public static object Probe()
    {
        var source = new Source(_ => true, () => false);
        var pointer = Marshal.GetComInterfaceForObject(source, typeof(IDropSource));
        bool callback;
        try
        {
            var query = Marshal.GetDelegateForFunctionPointer<QueryCallback>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(pointer), 3 * IntPtr.Size));
            callback = query(pointer, false, 0) == 0x40101 && source.Queries == 1;
        }
        finally { Marshal.Release(pointer); }
        var data = new DataObject(DataFormats.FileDrop, new[] { Path.Combine(Path.GetTempPath(), "audioxtractor-probe.wav") });
        pointer = Marshal.GetComInterfaceForObject(data, typeof(ComDataObject));
        bool fileDrop;
        try
        {
            var query = Marshal.GetDelegateForFunctionPointer<QueryData>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(pointer), 5 * IntPtr.Size));
            var format = new System.Runtime.InteropServices.ComTypes.FORMATETC { cfFormat = 15, dwAspect = System.Runtime.InteropServices.ComTypes.DVASPECT.DVASPECT_CONTENT, lindex = -1, tymed = System.Runtime.InteropServices.ComTypes.TYMED.TYMED_HGLOBAL };
            fileDrop = query(pointer, ref format) == 0;
        }
        finally { Marshal.Release(pointer); }
        return new { nativeSourceCallback = callback, nativeFileDropFormat = fileDrop, oleSta = Application.OleRequired() == ApartmentState.STA };
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QueryCallback(IntPtr self, [MarshalAs(UnmanagedType.Bool)] bool escape, uint keys);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QueryData(IntPtr self, ref System.Runtime.InteropServices.ComTypes.FORMATETC format);

    [DllImport("ole32.dll", PreserveSig = true)]
    static extern int DoDragDrop([MarshalAs(UnmanagedType.Interface)] ComDataObject data, [MarshalAs(UnmanagedType.Interface)] IDropSource source, uint allowedEffects, out uint effect);
}
