import org.omg.sysml.interactive.*;
import org.eclipse.xtext.validation.Issue;
import java.nio.file.*;
import java.util.*;

// Concatenates every .sysml given on the command line into ONE input (so
// cross-file references resolve regardless of order), validates it with the
// OMG Pilot Implementation and maps issue lines back to file:line.
public class Validate {
    public static void main(String[] a) throws Exception {
        SysMLInteractive s = SysMLInteractive.getInstance();
        s.loadLibrary(a[0]);
        StringBuilder sb = new StringBuilder();
        List<String> names = new ArrayList<>(); List<Integer> starts = new ArrayList<>();
        int line = 1;
        for (int i = 1; i < a.length; i++) {
            String t = Files.readString(Path.of(a[i]));
            names.add(a[i]); starts.add(line);
            sb.append(t); if (!t.endsWith("\n")) sb.append('\n');
            line += (int) t.chars().filter(c -> c == '\n').count() + (t.endsWith("\n") ? 0 : 1);
        }
        SysMLInteractiveResult r = s.process(sb.toString());
        if (r.getException() != null) { r.getException().printStackTrace(); System.exit(2); }
        int errs = 0, warns = 0;
        for (Issue is : r.getIssues()) {
            int l = is.getLineNumber() == null ? 0 : is.getLineNumber();
            int f = 0; for (int k = 0; k < starts.size(); k++) if (starts.get(k) <= l) f = k;
            String sev = is.getSeverity().toString();
            if (sev.equals("ERROR")) errs++; else warns++;
            System.out.println(sev + " " + names.get(f) + ":" + (l - starts.get(f) + 1) + ": " + is.getMessage());
        }
        System.out.println("== " + errs + " error(s), " + warns + " warning(s) in " + names.size() + " file(s)");
        System.exit(errs > 0 ? 1 : 0);
    }
}
